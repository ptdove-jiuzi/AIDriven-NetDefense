/**
 * Parameter normalisation: the only values a response action may carry.
 *
 * Every case here is a value that a naive implementation would happily forward:
 * an extra `cmd` key, a numeric string, a float, `NaN`, a quarantine root with
 * `..` in it, a root with `;` in it, a 5 KiB path, 17 keys. Forwarding any of
 * them is how a "structured" action turns into a command line.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BS, paramsFor } from './helpers.js';
import {
  ACTION_CATALOG,
  ACTION_IDS,
  DEFAULT_PARAMETER_ROOTS,
  getAction,
  normalizeParameters,
} from '../../packages/response-policy/index.js';

/** Roots used by the table-driven cases, wide enough not to mask the real error. */
const ROOTS = Object.freeze({
  linux: Object.freeze({ quarantine: Object.freeze(['/var']) }),
  windows: Object.freeze({ quarantine: Object.freeze([`C:${BS}Quarantine`]) }),
});

/**
 * @param {string} actionId Catalog action.
 * @param {unknown} raw Raw parameters.
 * @param {'linux' | 'windows'} [os] Target OS.
 * @param {object} [policyRoots] Root override for path parameters.
 * @returns {string} Policy error code, or `NO_THROW`.
 */
function codeOf(actionId, raw, os = 'windows', ...rest) {
  // 显式传 `undefined` 表示"不覆盖、用模块默认根"；不传则用本文件的宽根，
  // 以免根约束掩盖被测的那一条错误。
  const policyRoots = rest.length === 0 ? ROOTS[os] : rest[0];
  try {
    normalizeParameters(getAction(actionId), raw, { os, policyRoots });
    return 'NO_THROW';
  } catch (error) {
    return typeof error?.code === 'string' ? error.code : `THREW:${error?.name ?? 'unknown'}`;
  }
}

describe('parameter normalisation', () => {
  it('normalises an action with no parameters to an empty set', () => {
    const empty = paramsFor('observe.record_alert');
    assert.deepEqual(empty.value, {});
    assert.match(empty.digest, /^[0-9a-f]{64}$/u);
    assert.equal(Object.isFrozen(empty.value), true);
    assert.equal(codeOf('observe.record_alert', {}), 'NO_THROW');
    assert.equal(codeOf('observe.record_alert', undefined), 'NO_THROW');
  });

  it('rejects an undeclared parameter', () => {
    assert.equal(codeOf('process.terminate', { grace_period_ms: 1000, cmd: 'rm -rf /' }), 'DENY_PARAMETER_UNKNOWN_FIELD');
    assert.equal(codeOf('network.block_connection', { direction: 'both', rule: 'iptables -F' }), 'DENY_PARAMETER_UNKNOWN_FIELD');
    assert.equal(codeOf('file.quarantine', { quarantine_root: '/var/q', overwrite: true }), 'DENY_PARAMETER_UNKNOWN_FIELD');
  });

  it('rejects a missing required parameter', () => {
    assert.equal(codeOf('network.block_connection', {}), 'DENY_PARAMETER_MISSING');
    assert.equal(codeOf('network.block_connection', { duration_ms: 1000 }), 'DENY_PARAMETER_MISSING');
    assert.equal(codeOf('file.quarantine', {}), 'DENY_PARAMETER_MISSING');
    assert.equal(codeOf('network.isolate', undefined), 'DENY_PARAMETER_MISSING');
  });

  it('rejects an out-of-enum value', () => {
    assert.equal(codeOf('network.block_connection', { direction: 'sideways' }), 'DENY_PARAMETER_ENUM');
    assert.equal(codeOf('network.block_connection', { direction: 'BOTH' }), 'DENY_PARAMETER_ENUM');
    assert.equal(codeOf('network.block_connection', { direction: 1 }), 'DENY_PARAMETER_ENUM');
  });

  it('rejects integers outside the declared range', () => {
    assert.equal(codeOf('process.terminate', { grace_period_ms: 60001 }), 'DENY_PARAMETER_RANGE');
    assert.equal(codeOf('process.terminate', { grace_period_ms: -1 }), 'DENY_PARAMETER_RANGE');
    assert.equal(codeOf('network.block_connection', { direction: 'both', duration_ms: 999 }), 'DENY_PARAMETER_RANGE');
    assert.equal(codeOf('network.block_connection', { direction: 'both', duration_ms: 86400001 }), 'DENY_PARAMETER_RANGE');
    assert.equal(codeOf('process.terminate', { grace_period_ms: 0 }), 'NO_THROW');
    assert.equal(codeOf('process.terminate', { grace_period_ms: 60000 }), 'NO_THROW');
  });

  it('rejects non-integer numerics and numeric strings', () => {
    assert.equal(codeOf('process.terminate', { grace_period_ms: '1000' }), 'DENY_PARAMETER_TYPE');
    assert.equal(codeOf('process.terminate', { grace_period_ms: 1.5 }), 'DENY_PARAMETER_TYPE');
    assert.equal(codeOf('process.terminate', { grace_period_ms: Number.NaN }), 'DENY_PARAMETER_TYPE');
    assert.equal(codeOf('process.terminate', { grace_period_ms: Number.POSITIVE_INFINITY }), 'DENY_PARAMETER_TYPE');
    assert.equal(codeOf('process.terminate', { grace_period_ms: null }), 'DENY_PARAMETER_TYPE');
    assert.equal(codeOf('process.terminate', { grace_period_ms: true }), 'DENY_PARAMETER_TYPE');
  });

  it('rejects a non-boolean where a boolean is declared', () => {
    assert.equal(codeOf('file.quarantine', { quarantine_root: '/var/q', preserve_metadata: 'yes' }, 'linux'), 'DENY_PARAMETER_TYPE');
    assert.equal(codeOf('file.quarantine', { quarantine_root: '/var/q', preserve_metadata: 1 }, 'linux'), 'DENY_PARAMETER_TYPE');
    assert.equal(codeOf('file.quarantine', { quarantine_root: '/var/q', preserve_metadata: true }, 'linux'), 'NO_THROW');
  });

  it('rejects traversal in a path parameter', () => {
    assert.equal(codeOf('file.quarantine', { quarantine_root: '/var/quarantine/../etc' }, 'linux'), 'DENY_PARAMETER_PATH_TRAVERSAL');
    assert.equal(codeOf('file.quarantine', { quarantine_root: '/var/..' }, 'linux'), 'DENY_PARAMETER_PATH_TRAVERSAL');
    assert.equal(codeOf('file.quarantine', { quarantine_root: `/var${BS}..${BS}etc` }, 'windows'), 'DENY_PARAMETER_PATH_TRAVERSAL');
    // 行首的相对穿越同样算穿越，而不是"拼写不合法"。
    assert.equal(codeOf('file.quarantine', { quarantine_root: `..${BS}etc` }, 'windows'), 'DENY_PARAMETER_PATH_TRAVERSAL');
    assert.equal(codeOf('file.quarantine', { quarantine_root: '../etc' }, 'linux'), 'DENY_PARAMETER_PATH_TRAVERSAL');
  });

  it('keeps a quarantine root inside the declared root', () => {
    const windowsRoot = DEFAULT_PARAMETER_ROOTS.windows.quarantine[0];
    const linuxRoot = DEFAULT_PARAMETER_ROOTS.linux.quarantine[0];

    assert.equal(codeOf('file.quarantine', { quarantine_root: windowsRoot }, 'windows', undefined), 'NO_THROW');
    assert.equal(codeOf('file.quarantine', { quarantine_root: `${windowsRoot}${BS}run-1` }, 'windows', undefined), 'NO_THROW');
    assert.equal(codeOf('file.quarantine', { quarantine_root: linuxRoot }, 'linux', undefined), 'NO_THROW');

    // "Quarantine" must not become "move the file anywhere".
    assert.equal(
      codeOf('file.quarantine', { quarantine_root: `C:${BS}Windows${BS}System32` }, 'windows', undefined),
      'DENY_PARAMETER_OUTSIDE_ROOT',
    );
    assert.equal(codeOf('file.quarantine', { quarantine_root: '/etc' }, 'linux', undefined), 'DENY_PARAMETER_OUTSIDE_ROOT');
    // A prefix that merely starts with the same characters is not inside the root.
    assert.equal(
      codeOf('file.quarantine', { quarantine_root: `${windowsRoot}-evil` }, 'windows', undefined),
      'DENY_PARAMETER_OUTSIDE_ROOT',
    );
  });

  it('accepts a validated policy root override and rejects a malformed one', () => {
    const override = { quarantine: [`C:${BS}Sandbox`] };
    assert.equal(codeOf('file.quarantine', { quarantine_root: `C:${BS}Sandbox${BS}q` }, 'windows', override), 'NO_THROW');
    assert.equal(
      codeOf('file.quarantine', { quarantine_root: `C:${BS}Windows` }, 'windows', override),
      'DENY_PARAMETER_OUTSIDE_ROOT',
    );
    assert.equal(codeOf('file.quarantine', { quarantine_root: `C:${BS}Sandbox` }, 'windows', { quarantine: [] }), 'DENY_INPUT_INVALID');
    assert.equal(codeOf('file.quarantine', { quarantine_root: `C:${BS}Sandbox` }, 'windows', { quarantine: 'C:\\Sandbox' }), 'DENY_INPUT_INVALID');
    assert.equal(codeOf('file.quarantine', { quarantine_root: `C:${BS}Sandbox` }, 'windows', 'nope'), 'DENY_INPUT_INVALID');
    assert.equal(
      codeOf('file.quarantine', { quarantine_root: `C:${BS}Sandbox` }, 'windows', { quarantine: ['relative/path'] }),
      'DENY_INPUT_INVALID',
    );
  });

  it('rejects shell metacharacters inside a path parameter', () => {
    assert.equal(codeOf('file.quarantine', { quarantine_root: '/var/q; rm -rf /' }, 'linux'), 'DENY_PARAMETER_COMMAND_STRING');
    assert.equal(codeOf('file.quarantine', { quarantine_root: '/var/q$(id)' }, 'linux'), 'DENY_PARAMETER_COMMAND_STRING');
    assert.equal(codeOf('file.quarantine', { quarantine_root: '/var/q`id`' }, 'linux'), 'DENY_PARAMETER_COMMAND_STRING');
    assert.equal(codeOf('file.quarantine', { quarantine_root: '/var/q|nc 1.2.3.4 1' }, 'linux'), 'DENY_PARAMETER_COMMAND_STRING');
    assert.equal(codeOf('file.quarantine', { quarantine_root: '/var/q\nid' }, 'linux'), 'DENY_PARAMETER_COMMAND_STRING');
  });

  it('rejects a relative or non-canonical quarantine root', () => {
    assert.equal(codeOf('file.quarantine', { quarantine_root: 'quarantine' }, 'linux'), 'DENY_PARAMETER_NONCANONICAL');
    assert.equal(codeOf('file.quarantine', { quarantine_root: 'C:/a/b' }, 'windows'), 'DENY_PARAMETER_NONCANONICAL');
    assert.equal(codeOf('file.quarantine', { quarantine_root: `/var/q${BS}` }, 'linux'), 'DENY_PARAMETER_NONCANONICAL');
    assert.equal(codeOf('file.quarantine', { quarantine_root: `/var${BS}q` }, 'windows'), 'DENY_PARAMETER_NONCANONICAL');
  });

  it('rejects oversized parameter sets', () => {
    assert.equal(codeOf('file.quarantine', { quarantine_root: `/var/q/${'a'.repeat(5000)}` }, 'linux'), 'DENY_PARAMETER_TOO_LARGE');
    const many = {};
    for (let index = 0; index < 17; index += 1) many[`k${index}`] = index;
    assert.equal(codeOf('process.terminate', many), 'DENY_PARAMETER_TOO_LARGE');
  });

  it('rejects non-object parameter containers', () => {
    assert.equal(codeOf('process.terminate', null), 'DENY_PARAMETER_SHAPE');
    assert.equal(codeOf('process.terminate', []), 'DENY_PARAMETER_SHAPE');
    assert.equal(codeOf('process.terminate', 'grace_period_ms=1'), 'DENY_PARAMETER_SHAPE');
    assert.equal(codeOf('process.terminate', new Map()), 'DENY_PARAMETER_SHAPE');
  });

  it('binds the digest to the value, so one grant cannot cover another value', () => {
    const outbound = paramsFor('network.block_connection', { direction: 'outbound' });
    const both = paramsFor('network.block_connection', { direction: 'both' });
    const again = paramsFor('network.block_connection', { direction: 'outbound' });
    assert.equal(outbound.digest, again.digest);
    assert.notEqual(outbound.digest, both.digest);
    assert.deepEqual(outbound.value, { direction: 'outbound' });
    assert.equal(paramsFor('network.block_connection', { direction: 'both', duration_ms: 60000 }).value.duration_ms, 60000);
  });

  it('keeps address-shaped parameters out of the schema entirely', () => {
    // There is no action whose parameters accept an address, a port or a command:
    // those belong to the target, which is bound by digest and re-verified by the
    // helper. This test fails if such a parameter is ever added without review.
    const forbidden = ['address', 'port', 'host', 'command', 'args', 'argv', 'script', 'pid'];
    for (const id of ACTION_IDS) {
      for (const name of Object.keys(ACTION_CATALOG[id].parameters)) {
        assert.equal(forbidden.includes(name), false, `${id}.${name} reintroduces a free-form action input`);
      }
    }
  });
});
