/**
 * ADR pointer test.
 *
 * `ADR-0003` justifies shipping `window_start` / `window_end` on the Alert DTO by
 * citing exact `file:line` locations. Those pointers silently rotted once when
 * `packages/detection` grew by a dozen lines: the ADR then pointed at an unrelated
 * comment and a table row, which is exactly the failure mode that a `file:line`
 * reference is supposed to prevent.
 *
 * This test re-reads the ADR, resolves every `path:line` pointer it contains, and
 * checks the two semantic claims that make the ADR meaningful. Edit the cited
 * files and forget the ADR, and this goes red.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const ADR_PATH = 'docs/implementation/adr/ADR-0003-alert-window-contract-extension.md';
const adr = readFileSync(ADR_PATH, 'utf8');

/**
 * Read one line of a file, 1-based.
 *
 * @param {string} file Repository relative path.
 * @param {number} line 1-based line number.
 * @returns {string} The line contents.
 */
function lineOf(file, line) {
  const lines = readFileSync(file, 'utf8').split('\n');
  assert.ok(line >= 1 && line <= lines.length, `${file}:${line} is outside the file (${lines.length} lines)`);
  return lines[line - 1];
}

test('every file:line pointer quoted by ADR-0003 resolves to an existing line', () => {
  // 只认带扩展名的路径，避免把 §3.2 那类章节引用也当指针。
  const pointers = [...adr.matchAll(/([\w@./-]+\.(?:js|md)):(\d+)(?:-(\d+))?/gu)];
  assert.ok(pointers.length >= 4, `expected at least 4 pointers in ${ADR_PATH}, found ${pointers.length}`);
  for (const [, file, start, end] of pointers) {
    const first = Number(start);
    const last = end === undefined ? first : Number(end);
    assert.ok(last >= first, `${file}:${start}-${end} has an inverted range`);
    for (let line = first; line <= last; line += 1) {
      assert.notEqual(lineOf(file, line).trim(), '', `${file}:${line} is blank; the pointer is stale`);
    }
  }
});

test('ADR-0003 points at the lines that actually populate the window fields', () => {
  const pointer = /contracts-adapter\.js:(\d+)-(\d+)/u.exec(adr);
  assert.ok(pointer !== null, 'ADR-0003 must cite the adapter lines that fill window_start/window_end');
  const [first, second] = [Number(pointer[1]), Number(pointer[2])];
  assert.match(lineOf('packages/detection/src/contracts-adapter.js', first), /window_start: formatRfc3339Utc/u);
  assert.match(lineOf('packages/detection/src/contracts-adapter.js', second), /window_end: formatRfc3339Utc/u);
});

test('ADR-0003 points at the upsert constraint that motivates the extra fields', () => {
  const pointer = /INTEGRATION\.md:(\d+)/u.exec(adr);
  assert.ok(pointer !== null, 'ADR-0003 must cite the insert-only alert_id constraint');
  assert.match(lineOf('packages/detection/INTEGRATION.md', Number(pointer[1])), /alert_id.*不得被/u);
});

test('the contract still declares both window fields as required', () => {
  const pointer = /alert\.js:(\d+)/u.exec(adr);
  assert.ok(pointer !== null, 'ADR-0003 must cite the Alert schema lines');
  const first = Number(pointer[1]);
  assert.match(lineOf('packages/contracts/src/objects/alert.js', first), /window_start.*required: true/u);
  assert.match(lineOf('packages/contracts/src/objects/alert.js', first + 1), /window_end.*required: true/u);
});
