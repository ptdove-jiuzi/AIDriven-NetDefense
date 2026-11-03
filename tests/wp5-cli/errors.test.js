/**
 * errors.test.js — the two closed tables and their one-way relationship.
 *
 * A code without an exit mapping used to fall back to `INTERNAL`, which is silent: add a
 * code, forget the mapping, and every failure of that kind becomes exit 1 while the tests
 * stay green. The first two cases make that impossible.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CLI_CODES,
  CLI_EXIT,
  CliError,
  exitForCode,
  isCliError,
  toCliError,
} from '../../apps/cli/src/errors.js';
import { USAGE } from '../../apps/cli/src/main.js';

const EXIT_VALUES = new Set(Object.values(CLI_EXIT));

describe('code and exit tables', () => {
  it('maps every code to a declared exit status', () => {
    for (const code of Object.values(CLI_CODES)) {
      const status = exitForCode(code);
      assert.equal(Number.isInteger(status), true, `${code} has no integer exit status`);
      assert.ok(EXIT_VALUES.has(status), `${code} maps to ${status}, which is not a declared exit code`);
      assert.notEqual(status, undefined);
    }
  });

  it('declares no exit status that nothing can produce', () => {
    const produced = new Set(Object.values(CLI_CODES).map((code) => exitForCode(code)));
    for (const status of EXIT_VALUES) {
      assert.ok(produced.has(status), `exit ${status} is declared but no code maps to it`);
    }
  });

  it('pins the table sizes, so adding a code requires updating this test', () => {
    // This is not a duplicate of the two cases above: `exitForCode` falls back to 1 for an
    // unmapped code, and 1 is a declared exit status, so a forgotten mapping would still
    // satisfy the "every code maps somewhere" assertion. The literal sizes are what make
    // a silent addition visible — deliberately brittle, on purpose.
    assert.equal(Object.values(CLI_CODES).length, 17);
    assert.equal(Object.values(CLI_EXIT).length, 14);
  });

  it('documents every exit status in the usage text', () => {
    // `--help` is the only place an operator can look up an exit code without the source.
    for (const status of EXIT_VALUES) {
      assert.match(USAGE, new RegExp(`(?:^|\\s)${status}(?:\\s|$)`, 'u'), `exit ${status} is not documented in --help`);
    }
  });
});

describe('CliError', () => {
  it('normalizes an unregistered code to INTERNAL', () => {
    const error = new CliError('NOT_A_REAL_CODE', 'nope');
    assert.equal(error.code, CLI_CODES.INTERNAL);
    assert.equal(error.exitCode(), CLI_EXIT.INTERNAL);
  });

  it('renders only allowlisted detail keys', () => {
    const error = new CliError(CLI_CODES.BAD_RESPONSE, 'nope', {
      status: 500,
      field: 'lifecycle',
      token: 'secret',
      authorization: 'Bearer secret',
      body: 'secret',
      id: 'dropped-on-purpose',
      limit_bytes: Number.POSITIVE_INFINITY,
      reason: 'not a code!',
    });
    assert.deepEqual(error.details, { status: 500, field: 'lifecycle' });
  });

  it('wraps an unknown throw as INTERNAL without a stack in the message', () => {
    const wrapped = toCliError(new TypeError('boom\n    at somewhere'));
    assert.equal(wrapped.code, CLI_CODES.INTERNAL);
    assert.equal(isCliError(wrapped), true);
    assert.equal(wrapped.message.includes('\n'), false);
  });

  it('passes a CLI error through unchanged', () => {
    const original = new CliError(CLI_CODES.AUTH, 'nope');
    assert.equal(toCliError(original), original);
  });
});
