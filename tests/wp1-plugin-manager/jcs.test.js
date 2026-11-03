// author: PT-dove

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalize,
  canonicalizeJson,
  digestOf,
  ERROR_CODES,
  PluginCheckError,
  sha256Hex,
} from '../../apps/plugin-manager/src/index.js';

import { captureError } from './helpers.js';

test('JCS orders object members by UTF-16 code unit and preserves array order', () => {
  assert.equal(canonicalize({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(
    canonicalize({ 2: 'two', 1: 'one', 10: 'ten' }),
    '{"1":"one","10":"ten","2":"two"}',
    'numeric-looking keys sort as strings: "1" < "10" < "2"',
  );
  assert.equal(
    canonicalize({ 中: 2, '€': 1 }),
    '{"€":1,"中":2}',
    'U+20AC sorts before U+4E2D by code unit',
  );
  assert.equal(
    canonicalize({ '\uF900': 2, '😀': 1 }),
    '{"😀":1,"\uF900":2}',
    'an emoji surrogate pair (0xD83D) sorts before U+F900',
  );
  assert.equal(canonicalize([3, 1, 2]), '[3,1,2]', 'array order must never be sorted');
  assert.equal(canonicalize([{ b: 1, a: 2 }]), '[{"a":2,"b":1}]');
  assert.equal(canonicalize({}), '{}');
  assert.equal(canonicalize([]), '[]');
  assert.equal(canonicalize({ a: null, b: false }), '{"a":null,"b":false}');
});

test('JCS renders the RFC 8785 reference numbers', () => {
  const vectors = [
    [1e21, '1e+21'],
    [1e-7, '1e-7'],
    [0.000001, '0.000001'],
    [1e20, '100000000000000000000'],
    [-0, '0'],
    [4.5, '4.5'],
    [2e-3, '0.002'],
    [333333333.33333329, '333333333.3333333'],
    [5e-324, '5e-324'],
    [0, '0'],
    [-1.5, '-1.5'],
  ];
  for (const [value, expected] of vectors) {
    assert.equal(canonicalize(value), expected, `canonical number for ${String(value)}`);
  }
  assert.equal(canonicalize({ n: 1e21 }), '{"n":1e+21}');
  assert.equal(canonicalizeJson('{"n":1e21,"m":1e20}'), '{"m":100000000000000000000,"n":1e+21}');
});

test('JCS escapes only the required characters and keeps them lowercase', () => {
  assert.equal(canonicalize('a"b'), '"a\\"b"');
  assert.equal(canonicalize('a\\b'), '"a\\\\b"');
  assert.equal(canonicalize('a\nb'), '"a\\nb"');
  assert.equal(canonicalize('a\tb'), '"a\\tb"');
  assert.equal(canonicalize('\u0000'), '"\\u0000"');
  assert.equal(canonicalize('\u000f'), '"\\u000f"', 'hex digits must be lowercase');
  assert.equal(canonicalize('\u001f'), '"\\u001f"');
  assert.equal(canonicalize('a/b'), '"a/b"', 'solidus must not be escaped');
  assert.equal(canonicalize('é中'), '"é中"', 'non-ASCII characters stay verbatim');
  assert.equal(canonicalize('a"\\\u0001'), '"a\\"\\\\\\u0001"');
});

test('semantically equal objects collapse to one canonical string and one digest', () => {
  const left = { z: [1, { b: true, a: null }], a: 'x' };
  const right = { a: 'x', z: [1, { a: null, b: true }] };

  assert.equal(canonicalize(left), canonicalize(right));
  assert.equal(digestOf(left), digestOf(right));
  assert.match(digestOf(left), /^[0-9a-f]{64}$/);
  assert.equal(digestOf(left).length, 64);
  assert.equal(digestOf(left), sha256Hex(canonicalize(left)));
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('changing one value changes the digest', () => {
  assert.notEqual(digestOf({ a: 1 }), digestOf({ a: 2 }));
  assert.notEqual(digestOf({ a: '1' }), digestOf({ a: 1 }));
  assert.notEqual(digestOf({ a: 1 }), digestOf({ a: 1, b: null }));
  assert.notEqual(digestOf({ a: [1, 2] }), digestOf({ a: [2, 1] }));
  assert.notEqual(digestOf('payload'), digestOf('payloae'));
});

test('canonicalizeJson parses strict JSON before canonicalising', () => {
  assert.equal(canonicalizeJson('{"b":1,"a":[2,3]}'), '{"a":[2,3],"b":1}');
  assert.equal(canonicalizeJson('  { "n" : 1e21 }  '), '{"n":1e+21}');
  assert.deepEqual(canonicalizeJson('[true,null,"\\u00e9"]'), '[true,null,"é"]');
});

test('canonicalisation rejects values that are not I-JSON', () => {
  const circular = { a: 1 };
  circular.self = circular;

  const cases = [
    ['undefined', undefined],
    ['function', () => 1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['circular reference', circular],
    ['lone high surrogate', '\ud800'],
    ['lone low surrogate', 'a\udc00'],
    ['Date instance', new Date(0)],
    ['Map instance', new Map()],
    ['Set instance', new Set()],
    ['sparse array', [1, , 3]],
  ];

  for (const [label, value] of cases) {
    const error = captureError(() => canonicalize(value));
    assert.ok(error !== null, `${label} must be rejected`);
    assert.ok(error instanceof PluginCheckError, `${label} must throw PluginCheckError`);
    assert.equal(error.name, 'PluginCheckError', `${label} must be a PluginCheckError`);
    assert.equal(error.code, ERROR_CODES.INVALID_VALUE, `${label} must report INVALID_VALUE`);
    assert.equal(typeof error.message, 'string');
    assert.ok(error.message.length > 0, `${label} must carry a message`);
  }
});

test('sha256Hex rejects non-string, non-byte input', () => {
  const error = captureError(() => sha256Hex(42));
  assert.ok(error instanceof PluginCheckError);
  assert.equal(error.code, ERROR_CODES.INVALID_ARGUMENT);
  assert.equal(sha256Hex(new Uint8Array([0x61, 0x62, 0x63])), sha256Hex('abc'));
});
