// author: PT-dove

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodeUtf8Strict,
  ERROR_CODES,
  parseStrictJson,
  PluginCheckError,
} from '../../apps/plugin-manager/src/index.js';

import { captureError } from './helpers.js';

function expectCode(run, code, label) {
  const error = captureError(run);
  assert.ok(error !== null, `${label}: expected a PluginCheckError`);
  assert.ok(error instanceof PluginCheckError, `${label}: expected PluginCheckError, got ${error?.name}`);
  assert.equal(error.code, code, `${label}: expected ${code}, got ${error.code} (${error.message})`);
  return error;
}

function nestArrays(levels) {
  let value = [];
  for (let index = 1; index < levels; index += 1) value = [value];
  return value;
}

test('duplicate object keys are rejected at the top level', () => {
  const error = expectCode(() => parseStrictJson('{"a":1,"a":2}'), ERROR_CODES.DUPLICATE_KEY, 'flat duplicate');
  assert.match(error.message, /duplicate object key/);
});

test('duplicate object keys are rejected inside nested objects', () => {
  expectCode(
    () => parseStrictJson('{"outer":{"k":1,"k":2}}'),
    ERROR_CODES.DUPLICATE_KEY,
    'nested duplicate',
  );
  expectCode(
    () => parseStrictJson('{"list":[{"x":1,"x":1}]}'),
    ERROR_CODES.DUPLICATE_KEY,
    'duplicate inside array element',
  );
});

test('invalid UTF-8 bytes are rejected by decodeUtf8Strict', () => {
  expectCode(() => decodeUtf8Strict(Buffer.from([0xff, 0xfe])), ERROR_CODES.INVALID_UNICODE, '0xFF 0xFE');
  expectCode(
    () => decodeUtf8Strict(Buffer.from([0x22, 0xc3, 0x28, 0x22])),
    ERROR_CODES.INVALID_UNICODE,
    'truncated two byte sequence',
  );
  expectCode(() => decodeUtf8Strict(Buffer.from([0xed, 0xa0, 0x80])), ERROR_CODES.INVALID_UNICODE, 'CESU-8 surrogate');
  assert.equal(decodeUtf8Strict(Buffer.from('{"a":1}', 'utf8')), '{"a":1}');
});

test('lone surrogate escapes and raw lone surrogates are rejected', () => {
  expectCode(() => parseStrictJson('"\\ud800"'), ERROR_CODES.INVALID_UNICODE, 'escaped high surrogate');
  expectCode(() => parseStrictJson('"\\udc00"'), ERROR_CODES.INVALID_UNICODE, 'escaped low surrogate');
  expectCode(() => parseStrictJson(`"${String.fromCharCode(0xd800)}"`), ERROR_CODES.INVALID_UNICODE, 'raw high surrogate');
  assert.equal(parseStrictJson('"\\ud83d\\ude00"'), '😀', 'a valid surrogate pair must still decode');
});

test('raw control characters inside strings are rejected', () => {
  expectCode(
    () => parseStrictJson(`"a${String.fromCharCode(0x01)}b"`),
    ERROR_CODES.INVALID_JSON,
    'raw U+0001',
  );
  expectCode(
    () => parseStrictJson(`"a${String.fromCharCode(0x1f)}b"`),
    ERROR_CODES.INVALID_JSON,
    'raw U+001F',
  );
  assert.equal(parseStrictJson('"a\\u0001b"'), `a${String.fromCharCode(0x01)}b`, 'escaped control is legal');
});

test('malformed number literals are rejected', () => {
  for (const literal of ['01', '+1', '.5', '1.', '1e', '-', '0x10', 'Infinity', 'NaN']) {
    expectCode(() => parseStrictJson(literal), ERROR_CODES.INVALID_JSON, `number literal ${literal}`);
  }
  assert.equal(parseStrictJson('-0'), -0);
  assert.equal(parseStrictJson('1e21'), 1e21);
});

test('trailing content after the JSON value is rejected', () => {
  expectCode(() => parseStrictJson('{"a":1}x'), ERROR_CODES.INVALID_JSON, 'trailing x');
  expectCode(() => parseStrictJson('1 2'), ERROR_CODES.INVALID_JSON, 'trailing number');
  expectCode(() => parseStrictJson('{} {}'), ERROR_CODES.INVALID_JSON, 'two documents');
  expectCode(() => parseStrictJson('{"a":1,}'), ERROR_CODES.INVALID_JSON, 'trailing comma');
  expectCode(() => parseStrictJson('// c\n{}'), ERROR_CODES.INVALID_JSON, 'comment');
});

test('nesting depth and byte size limits are enforced', () => {
  const deep = `${'['.repeat(40)}${']'.repeat(40)}`;
  expectCode(() => parseStrictJson(deep), ERROR_CODES.LIMIT_EXCEEDED, 'depth 40');
  expectCode(
    () => parseStrictJson('[[]]', { maxDepth: 1 }),
    ERROR_CODES.LIMIT_EXCEEDED,
    'custom depth 1',
  );

  const big = `{"a":"${'x'.repeat(70000)}"}`;
  expectCode(() => parseStrictJson(big), ERROR_CODES.LIMIT_EXCEEDED, 'default 64 KiB');
  expectCode(() => parseStrictJson('{"a":1}', { maxBytes: 4 }), ERROR_CODES.LIMIT_EXCEEDED, 'custom 4 bytes');

  assert.deepEqual(
    parseStrictJson(`${'['.repeat(10)}${']'.repeat(10)}`),
    nestArrays(10),
    'ten levels must stay inside the default limit',
  );
});

test('the parser never pollutes Object.prototype through __proto__', () => {
  const value = parseStrictJson('{"__proto__":{"polluted":true},"a":1}');

  assert.equal({}.polluted, undefined, 'Object.prototype must not be polluted');
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(Object.getPrototypeOf(value), Object.prototype, 'the result keeps a plain prototype');
  assert.equal(value.a, 1);

  const descriptor = Object.getOwnPropertyDescriptor(value, '__proto__');
  assert.ok(descriptor !== undefined, '__proto__ must become an own data property');
  assert.equal(descriptor.enumerable, true);
  assert.equal(descriptor.value.polluted, true);
  assert.equal(Object.getPrototypeOf(descriptor.value), Object.prototype);
});

test('parseStrictJson rejects non-string input and invalid options', () => {
  expectCode(() => parseStrictJson(42), ERROR_CODES.INVALID_ARGUMENT, 'number input');
  expectCode(() => parseStrictJson('{}', { maxBytes: 0 }), ERROR_CODES.INVALID_ARGUMENT, 'maxBytes 0');
  expectCode(() => parseStrictJson('{}', { maxDepth: -1 }), ERROR_CODES.INVALID_ARGUMENT, 'maxDepth -1');
  expectCode(() => decodeUtf8Strict('not bytes'.length), ERROR_CODES.INVALID_ARGUMENT, 'non buffer');
});
