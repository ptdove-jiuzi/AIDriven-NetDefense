/**
 * log.test.js — logging and time helpers.
 *
 * Two properties: a secret cannot leave through a log line, and a log line is
 * always parseable JSON (no ANSI, no locale-dependent time). The clock helpers are
 * covered for the specific misuse that matters — treating wall time as monotonic.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createLogger, nullLogger, redact } from '../../apps/daemon/src/log.js';
import { assertClock, createManualClock, createSystemClock, fromIso, toIso } from '../../apps/daemon/src/clock.js';
import { DAEMON_CODES } from '../../apps/daemon/src/errors.js';
import { BASE_MS } from './helpers.js';

function capture(level = 'debug') {
  const lines = [];
  const stream = {
    write(chunk) {
      lines.push(chunk);
    },
  };
  const logger = createLogger({ stream, level, clock: createManualClock(BASE_MS) });
  return { logger, lines, parse: () => lines.map((line) => JSON.parse(line)) };
}

describe('redact', () => {
  it('replaces secret-looking keys at any depth', () => {
    const redacted = redact({
      token: 'abc',
      nested: { apiKey: 'def', authorization: 'Bearer xyz', keep: 'visible' },
      list: [{ password: 'p' }],
    });
    assert.equal(redacted.token, '[redacted]');
    assert.equal(redacted.nested.apiKey, '[redacted]');
    assert.equal(redacted.nested.authorization, '[redacted]');
    assert.equal(redacted.nested.keep, 'visible');
    assert.equal(redacted.list[0].password, '[redacted]');
  });

  it('cuts cycles and depth instead of throwing', () => {
    const cyclic = { name: 'a' };
    cyclic.self = cyclic;
    const redacted = redact(cyclic);
    assert.equal(redacted.self, '[circular]');
    let deep = { value: 1 };
    for (let index = 0; index < 10; index += 1) {
      deep = { next: deep };
    }
    const limited = redact(deep);
    assert.equal(JSON.stringify(limited).includes('[depth-limit]'), true);
  });

  it('serializes an error by name, code and message only', () => {
    const error = Object.assign(new Error('boom'), { code: 'E_X' });
    const redacted = redact({ error });
    assert.deepEqual(redacted.error, { name: 'Error', code: 'E_X', message: 'boom' });
  });
});

describe('createLogger', () => {
  it('writes one JSON object per line with level and message', () => {
    const { logger, parse } = capture();
    logger.info('hello', { source_id: 'synthetic.process' });
    const record = parse()[0];
    assert.equal(record.level, 'info');
    assert.equal(record.msg, 'hello');
    assert.equal(record.source_id, 'synthetic.process');
    assert.equal(record.at, '2026-11-02T00:00:00.000Z');
  });

  it('never writes a token, even when a caller passes one', () => {
    const { logger, lines } = capture();
    logger.info('auth', { token: 'super-secret-token', nested: { api_key: 'k' } });
    assert.equal(lines[0].includes('super-secret-token'), false);
    assert.equal(lines[0].includes('"k"'), false);
  });

  it('honours the level threshold', () => {
    const { logger, lines } = capture('warn');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    assert.equal(lines.length, 2);
    assert.equal(lines[0].includes('"w"'), true);
  });

  it('is silent at level silent', () => {
    const { logger, lines } = capture('silent');
    logger.error('nothing');
    assert.deepEqual(lines, []);
  });

  it('derives a child logger with bound fields', () => {
    const { logger, parse } = capture();
    logger.child({ source_id: 'synthetic.one' }).info('poll');
    assert.equal(parse()[0].source_id, 'synthetic.one');
  });

  it('does not fail the caller when the stream throws', () => {
    const logger = createLogger({
      stream: {
        write() {
          throw new Error('EPIPE');
        },
      },
      level: 'debug',
    });
    assert.doesNotThrow(() => logger.error('still alive'));
  });

  it('rejects an unknown level at construction', () => {
    assert.throws(() => createLogger({ stream: { write() {} }, level: 'verbose' }), /unknown log level/u);
  });

  it('nullLogger swallows everything and chains', () => {
    assert.doesNotThrow(() => nullLogger.child({}).info('x'));
  });
});

describe('clock', () => {
  it('renders and parses RFC3339 UTC with milliseconds', () => {
    assert.equal(toIso(BASE_MS), '2026-11-02T00:00:00.000Z');
    assert.equal(fromIso('2026-11-02T00:00:00.000Z'), BASE_MS);
    assert.throws(() => toIso(-1), (error) => {
      assert.equal(error.code, DAEMON_CODES.BATCH_INVALID);
      return true;
    });
    assert.throws(() => toIso(1.5), /safe integer/u);
    assert.throws(() => fromIso('2026-11-02T00:00:00Z'), /RFC3339/u);
    assert.throws(() => fromIso('2026-11-02 00:00:00.000Z'), /RFC3339/u);
  });

  it('keeps wall and monotonic time independent', () => {
    const clock = createManualClock(BASE_MS);
    clock.advanceWall(5000);
    assert.equal(clock.nowMs(), BASE_MS + 5000);
    assert.equal(clock.monoMs(), 0, 'a wall step must not move the monotonic clock');
    clock.advanceMono(700);
    assert.equal(clock.monoMs(), 700);
    assert.equal(clock.nowMs(), BASE_MS + 5000);
    clock.advance(1000);
    assert.equal(clock.nowMs(), BASE_MS + 6000);
    assert.equal(clock.monoMs(), 1700);
  });

  it('can move the wall clock backwards without breaking the monotonic origin', () => {
    const clock = createManualClock(BASE_MS);
    clock.setWall(BASE_MS - 60000);
    assert.equal(clock.nowMs(), BASE_MS - 60000);
    assert.equal(clock.monoMs(), 0);
    assert.equal(clock.nowIso(), '2026-11-01T23:59:00.000Z');
  });

  it('provides a monotonic system clock', () => {
    const clock = createSystemClock();
    const first = clock.monoMs();
    const second = clock.monoMs();
    assert.ok(second >= first);
    assert.match(clock.nowIso(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  });

  it('asserts a usable clock', () => {
    assert.throws(() => assertClock({}), /clock.nowMs/u);
    assert.throws(() => assertClock(null), /clock must be an object/u);
  });
});
