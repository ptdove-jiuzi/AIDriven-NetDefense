/**
 * api/cursor.js — opaque, signed keyset pagination cursors.
 *
 * A cursor is a position in a total order, not a record handle: it names the
 * `(sort milliseconds, id)` pair the next page starts *after*. Offsets were
 * rejected because concurrent writes shift them — a page boundary can then skip a
 * row or repeat one. A keyset position cannot: it only says "strictly past this
 * pair", which is stable even while rows are inserted or merged.
 *
 * Why sign it at all: the position is derived from stored rows. An unsigned cursor
 * would let any authenticated caller forge a position and, worse, hand-craft ids
 * that read like data. The MAC makes the cursor unforgeable; the payload stays
 * fixed-width so a tampered length cannot be used to walk the decoder.
 *
 * **A cursor is opaque.** Clients must not parse, edit, join or reuse one across
 * endpoints. Two properties follow from that, both intentional:
 *
 * - The MAC key is *derived* from the API token one way. Holding a cursor reveals
 *   nothing about the token, and rotating the token invalidates every outstanding
 *   cursor at once. Clients that see `CURSOR_INVALID` restart from the first page.
 * - The endpoint tag is inside the payload, so an `alerts` cursor offered to
 *   `analysis` is rejected instead of silently reading the wrong ordering.
 *
 * Payload layout (fixed, version 1):
 *
 * ```
 * [0]      version (0x01)
 * [1]      endpoint tag (0x01 alerts, 0x02 analysis)
 * [2..9]   sort milliseconds, int64 big endian
 * [10]     id byte length (1 byte)
 * [11..]   id, UTF-8
 * ```
 *
 * The token is `base64url(payload) + "." + base64url(HMAC-SHA256(key, payload))`
 * with the full 32-byte MAC — a truncated MAC would buy nothing here but would
 * weaken the only integrity check the format has.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { API_CODES, ApiError } from './errors.js';

/** Payload layout version. A mismatch is a rejection, never a best-effort parse. */
export const CURSOR_VERSION = 1;

/** Hard character cap. Longer input is refused before any decoding work happens. */
export const MAX_CURSOR_CHARS = 512;

/** Endpoint tags. The values are part of the on-the-wire format. */
export const CURSOR_KIND = Object.freeze({ alerts: 1, analysis: 2 });

const KIND_VALUES = new Set(Object.values(CURSOR_KIND));
const MAC_BYTES = 32;
const FIXED_BYTES = 11;
/**
 * What an id may look like: 1..128 printable ASCII bytes, nothing narrower.
 *
 * `alert_id` and `analysis_id` are `TEXT PRIMARY KEY` in the store, with no
 * `CHECK` constraining the spelling, so any ASCII text the writer accepted can
 * legitimately appear in a row. A narrower pattern here (the earlier
 * `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`) therefore failed *while encoding the
 * `next_cursor` of a successful read* — a stored `alert_id` of `has space` turned
 * a legal request over legal rows into `QUERY_INVALID`, i.e. the server reported
 * its own storage contents as the caller's mistake. That must never happen: a
 * valid request that produced a valid row is never a 4xx.
 *
 * Widening it this far is safe for the wire format. The id sits **inside** the
 * base64url payload, so characters such as `.` are encoded away before the token
 * is assembled; the only literal `.` in a cursor is the separator between payload
 * and MAC, and `decode` splits on it before any base64url decoding, so an id can
 * never be mistaken for a segment boundary. 128 ASCII bytes also leave
 * `payload[10]` a safe, exact length byte.
 *
 * `encode` and `decode` both test this one constant, so the two sides cannot
 * drift apart.
 */
const ID_PATTERN = /^[\x20-\x7E]{1,128}$/u;

/**
 * Build a rejection whose `reason` is the only thing that leaves the module.
 *
 * The original decode exception is deliberately dropped: a `RangeError` from a
 * buffer read names internal offsets, and echoing it would turn a caller-triggered
 * error into a description of the implementation.
 *
 * @param {string} reason Short reason word from the contract.
 * @returns {ApiError} Error ready to be rendered as `400 CURSOR_INVALID`.
 */
function invalid(reason) {
  return new ApiError(API_CODES.CURSOR_INVALID, 'cursor is not valid', { reason });
}

/**
 * Decode base64url only if the encoding is the canonical one.
 *
 * Node's decoder is intentionally lenient: it accepts `+`/`/`, stray `=`, and
 * non-zero trailing bits. Every alias would let the same position be spelled in
 * several ways, so the round trip is the check — anything that does not re-encode
 * to the identical string is not a cursor we issued.
 *
 * @param {string} text Candidate segment.
 * @returns {Buffer|null} Bytes, or `null` when non-canonical.
 */
function decodeCanonical(text) {
  if (text.length === 0) {
    return null;
  }
  const bytes = Buffer.from(text, 'base64url');
  return bytes.toString('base64url') === text ? bytes : null;
}

/**
 * Create a codec bound to one secret.
 *
 * @param {Buffer|string} secret MAC key material. In the daemon this is the value
 *   derived in `auth.js`, never the token itself.
 * @returns {{encode: (position: {kind: number, ms: number, id: string}) => string,
 *   decode: (text: string, options?: {kind?: number}) => {kind: number, ms: number, id: string}}}
 *   Codec.
 */
export function createCursorCodec(secret) {
  const valid = Buffer.isBuffer(secret) ? secret.length > 0 : (typeof secret === 'string' && secret.length > 0);
  if (!valid) {
    // A codec without key material would sign with nothing. That is an internal
    // wiring fault, so it is reported with the same code as any other misuse of
    // this module rather than producing unsigned cursors.
    throw new ApiError(API_CODES.QUERY_INVALID, 'cursor codec requires key material', { reason: 'secret' });
  }

  function mac(payload) {
    return createHmac('sha256', secret).update(payload).digest();
  }

  /**
   * Encode a position.
   *
   * Every argument here comes from a stored row, so a failure is a programming
   * fault rather than caller input; it still surfaces as `QUERY_INVALID` because
   * that is the API layer's only "this request cannot be served as asked" code and
   * a cursor is never worth a `500`.
   *
   * @param {{kind: number, ms: number, id: string}} position Position.
   * @returns {string} Signed cursor.
   */
  function encode(position) {
    const { kind, ms, id } = position ?? {};
    if (!KIND_VALUES.has(kind)) {
      throw new ApiError(API_CODES.QUERY_INVALID, 'cursor position has no endpoint tag', { reason: 'kind' });
    }
    if (!Number.isSafeInteger(ms) || ms < 0) {
      throw new ApiError(API_CODES.QUERY_INVALID, 'cursor position has no sort time', { reason: 'ms' });
    }
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      throw new ApiError(API_CODES.QUERY_INVALID, 'cursor position has no usable id', { reason: 'id' });
    }
    const idBytes = Buffer.from(id, 'utf8');
    const payload = Buffer.alloc(FIXED_BYTES + idBytes.length);
    payload[0] = CURSOR_VERSION;
    payload[1] = kind;
    payload.writeBigInt64BE(BigInt(ms), 2);
    payload[10] = idBytes.length;
    idBytes.copy(payload, FIXED_BYTES);
    return `${payload.toString('base64url')}.${mac(payload).toString('base64url')}`;
  }

  /**
   * Decode and verify a cursor.
   *
   * Checks run cheapest-first and the signature runs before the payload is
   * interpreted: without the key an attacker never reaches the parser, so the
   * only reachable rejections are the documented ones.
   *
   * @param {string} text Cursor from the query string.
   * @param {{kind?: number}} [options] Expected endpoint tag.
   * @returns {{kind: number, ms: number, id: string}} Verified position.
   */
  function decode(text, options = undefined) {
    if (typeof text !== 'string') {
      throw invalid('malformed');
    }
    if (text.length > MAX_CURSOR_CHARS) {
      throw invalid('too_long');
    }
    const segments = text.split('.');
    if (segments.length !== 2) {
      throw invalid('malformed');
    }
    const payload = decodeCanonical(segments[0]);
    const presentedMac = decodeCanonical(segments[1]);
    if (payload === null || presentedMac === null) {
      throw invalid('malformed');
    }
    // Contract §4.4 fixes which reason owns which defect: `signature` means "the MAC
    // is exactly 32 bytes and does not match this payload". A MAC segment that is
    // canonical base64url but decodes to some other length is therefore *not* a
    // signature failure — the token does not have the shape of a cursor we could ever
    // have issued, so it is `malformed`. Reporting `signature` here would tell the
    // caller their MAC was wrong when the real defect is the length, and would make
    // the `malformed` branch in the contract's table unimplementable for this input.
    if (presentedMac.length !== MAC_BYTES) {
      throw invalid('malformed');
    }
    if (!timingSafeEqual(presentedMac, mac(payload))) {
      throw invalid('signature');
    }

    if (payload.length < FIXED_BYTES) {
      throw invalid('malformed');
    }
    if (payload[0] !== CURSOR_VERSION) {
      throw invalid('malformed');
    }
    const payloadKind = payload[1];
    if (!KIND_VALUES.has(payloadKind)) {
      throw invalid('malformed');
    }
    const idLength = payload[10];
    if (idLength === 0 || payload.length !== FIXED_BYTES + idLength) {
      throw invalid('malformed');
    }
    const idBytes = payload.subarray(FIXED_BYTES);
    const id = idBytes.toString('utf8');
    // A UTF-8 round trip rejects overlong or lone-surrogate spellings that decode
    // to a valid-looking string but would re-encode to different bytes.
    if (!Buffer.from(id, 'utf8').equals(idBytes) || !ID_PATTERN.test(id)) {
      throw invalid('malformed');
    }
    const ms = Number(payload.readBigInt64BE(2));
    if (!Number.isSafeInteger(ms) || ms < 0) {
      throw invalid('malformed');
    }
    if (options?.kind !== undefined && payloadKind !== options.kind) {
      throw invalid('kind');
    }
    return { kind: payloadKind, ms, id };
  }

  return { encode, decode };
}
