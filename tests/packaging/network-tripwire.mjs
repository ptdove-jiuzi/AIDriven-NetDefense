/**
 * Network tripwire for the M8 embedded-runtime PoC.
 *
 * Loaded with `--import` into the bundled worker so a launch that boots to the
 * stdio stage can be asserted to have made **zero** outbound connection attempts:
 * every TCP connect, every DNS lookup and every http(s) request is recorded and
 * then rejected with `ERR_M8_NETWORK_BLOCKED`.
 *
 * `$M8_TRIPWIRE_ALLOW` is a comma-separated `host:port` allowlist. It exists for
 * exactly one case: the stubbed broker, which the reviewed profile is configured
 * to reach on loopback. An allowed connect is recorded as `net.allowed`, so the
 * log still distinguishes "went to the loopback broker" from "tried to leave the
 * machine" — the second one always throws. With the variable unset the tripwire
 * behaves exactly as before, which is what the zero-egress assertions rely on.
 *
 * `--selftest` proves the tripwire itself can fail: it attempts a loopback
 * connect and expects the block. A tripwire that cannot be triggered is not
 * evidence of anything.
 *
 * Records are appended as JSON lines to `$M8_TRIPWIRE_LOG`, which must live
 * inside the attempt's session root.
 */

import { appendFileSync } from 'node:fs';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

export const BLOCK_CODE = 'ERR_M8_NETWORK_BLOCKED';

const logPath = process.env.M8_TRIPWIRE_LOG;
const allowed = new Set(String(process.env.M8_TRIPWIRE_ALLOW ?? '')
  .split(',')
  .map((entry) => entry.trim().toLowerCase())
  .filter((entry) => entry.length > 0));

function describe(value) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') {
    const host = value.host ?? value.hostname ?? '';
    const port = value.port ?? '';
    const path = value.path ?? '';
    return [host, port, path].filter((part) => String(part).length > 0).join(':');
  }
  return String(value);
}

/**
 * `host:port` of a `connect`-style argument list, or `undefined` when the target
 * is not a TCP endpoint (a pipe or an IPC path can never reach the network).
 *
 * Node's own `net.connect` normalises its arguments and then calls
 * `socket.connect([options])` — a single array argument — so a single level of
 * unwrapping is required for the allowlist to see the real destination.
 */
function endpointOf(args) {
  let list = args;
  for (let guard = 0; guard < 4 && list.length === 1 && Array.isArray(list[0]); guard += 1) list = list[0];
  const first = list[0];
  if (typeof first === 'number') {
    return { host: typeof list[1] === 'string' ? list[1] : 'localhost', port: first };
  }
  if (typeof first === 'object' && first !== null) {
    if (first.path !== undefined) return undefined;
    const port = Number(first.port);
    if (!Number.isFinite(port)) return undefined;
    return { host: String(first.host ?? first.hostname ?? 'localhost'), port };
  }
  return undefined;
}

function isAllowed(args) {
  const target = endpointOf(args);
  if (target === undefined || allowed.size === 0) return false;
  return allowed.has(`${target.host.toLowerCase()}:${target.port}`);
}


function record(kind, detail) {
  const line = `${JSON.stringify({ pid: process.pid, kind, detail: String(detail).slice(0, 512) })}\n`;
  if (typeof logPath !== 'string' || logPath.length === 0) {
    livenessFailed('M8_TRIPWIRE_LOG is unset');
    return;
  }
  try {
    appendFileSync(logPath, line);
  } catch (error) {
    livenessFailed(`cannot append to M8_TRIPWIRE_LOG: ${error?.message ?? error}`);
  }
}

/**
 * An unwritable log must not look like "no attempts happened": the absence of a
 * record is only meaningful when the tripwire proved it was armed.
 */
function livenessFailed(reason) {
  process.stderr.write(`m8-tripwire: ${reason}\n`);
  process.exit(3);
}

function blocked(kind, detail) {
  const error = new Error(`M8 tripwire blocked ${kind}: outbound network is forbidden in this verification`);
  error.code = BLOCK_CODE;
  // Record first: a throw without a record would hide the attempt.
  record(kind, describe(detail));
  return error;
}

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function patchedConnect(...args) {
  if (isAllowed(args)) {
    const target = endpointOf(args);
    record('net.allowed', `${target.host}:${target.port}`);
    return originalConnect.apply(this, args);
  }
  throw blocked('net.socket.connect', args[0]);
};
net.Socket.prototype.connect.toString = () => 'patchedConnect';

for (const name of ['connect', 'createConnection']) {
  if (typeof net[name] === 'function') {
    const original = net[name];
    net[name] = function patched(...args) {
      // No record here: `net.connect` immediately calls `socket.connect`, which is
      // also patched and records the single allowed hop. Recording both would
      // double-count one connection.
      if (isAllowed(args)) return original.apply(this, args);
      throw blocked(`net.${name}`, args[0]);
    };
  }
}

for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny']) {
  if (typeof dns[name] === 'function') {
    dns[name] = function patched(...args) {
      throw blocked(`dns.${name}`, args[0]);
    };
  }
}
if (dns.promises !== undefined) {
  for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6']) {
    if (typeof dns.promises[name] === 'function') {
      dns.promises[name] = async function patched(...args) {
        throw blocked(`dns.promises.${name}`, args[0]);
      };
    }
  }
}

for (const [module, label] of [[http, 'http'], [https, 'https']]) {
  for (const name of ['request', 'get']) {
    if (typeof module[name] === 'function') {
      module[name] = function patched(...args) {
        throw blocked(`${label}.${name}`, args[0]);
      };
    }
  }
}

// Proof of life: an empty log only means "no attempts" if the tripwire was armed.
record('armed', process.pid);
