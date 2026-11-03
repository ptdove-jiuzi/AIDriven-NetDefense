/**
 * query.test.js — unit coverage for the page assembler.
 *
 * `buildPage` owns exactly one branch that the endpoints cannot reach: the 256 KiB
 * byte cap. Contract §9 says so plainly — with `limit ≤ 100` and a fixed field set a
 * page tops out around 40 KB, so `byte_limited:true` is a guardrail, not a routine
 * path. Calling the endpoint with real rows therefore proves nothing about it; the
 * only honest way to cover the trim (and its "at least one row" floor) is to call the
 * assembler with a small `byteCap`.
 *
 * The rows here are synthetic and deliberately not contract-shaped: `buildPage` takes
 * already-projected items and only measures their serialized size, so what matters is
 * that each item is a couple of hundred bytes — not which fields it carries.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildPage } from '../../apps/daemon/src/api/query.js';

/** Bytes of filler per synthetic item, chosen so two items fit under {@link BYTE_CAP} and five do not. */
const PADDING = 160;

/** Small cap that forces trimming without falling to the one-row floor. */
const BYTE_CAP = 650;

/**
 * Build `count` items of roughly 200 serialized bytes each.
 *
 * @param {number} count Item count.
 * @returns {{index: number, alert_id: string, padding: string}[]} Items.
 */
function syntheticRows(count) {
  return Array.from({ length: count }, (_, index) => ({
    index,
    alert_id: `al-${index}`,
    padding: 'x'.repeat(PADDING),
  }));
}

/**
 * Cursor encoder that names the row the next page starts after.
 *
 * @param {{index: number}} row Last kept row.
 * @returns {string} Opaque marker, decoded below by index.
 */
function encodeNext(row) {
  return `after:${row.index}`;
}

describe('buildPage byte trimming', () => {
  it('trims to the byte cap, keeps at least one row, and loses no row when continued', () => {
    const all = syntheticRows(5);
    const seen = [];
    let start = 0;
    let hops = 0;

    for (;;) {
      const page = buildPage({
        rows: all.slice(start),
        limit: 5,
        hasMore: false,
        byteCap: BYTE_CAP,
        encodeNext,
      });
      seen.push(...page.items.map((row) => row.index));
      hops += 1;
      assert.ok(hops <= 6, '按字节裁剪后必须在有限页内终止');

      if (hops === 1) {
        // The first page is the one that proves the cap fired: five rows were offered,
        // fewer came back, and the page still points forward.
        assert.equal(page.page.byte_limited, true, '裁剪后 byte_limited 必须为 true');
        assert.ok(page.page.returned < 5, `五条合成行在 ${BYTE_CAP} 字节下必须被裁剪，实际返回 ${page.page.returned}`);
        assert.ok(page.page.returned >= 1, '裁剪不得返回空页');
        assert.equal(page.page.has_more, true, '被裁掉的行意味着 has_more 必须为 true');
        assert.equal(typeof page.page.next_cursor, 'string', '裁剪后必须给出续页游标');
        assert.ok(page.page.next_cursor.length > 0, '续页游标必须非空');
        assert.equal(page.items.length, page.page.returned, 'items 与 returned 必须一致');
      }

      if (page.page.next_cursor === null) {
        break;
      }
      const marker = Number(page.page.next_cursor.slice('after:'.length));
      const position = all.findIndex((row) => row.index === marker);
      assert.ok(position >= start, '续页游标必须指向本页之内的行');
      start = position + 1;
    }

    assert.deepEqual(seen, [0, 1, 2, 3, 4], '拼接各页后不得丢行、不得重复、不得乱序');

    // The floor: a cap that cannot hold even one row must still return the first row,
    // because an empty page with `has_more:true` is a page no client can advance past.
    const floor = buildPage({ rows: all, limit: 5, hasMore: false, byteCap: 1, encodeNext });
    assert.equal(floor.page.returned, 1, 'byteCap 小到放不下任何行时仍必须保留 1 行');
    assert.deepEqual(floor.items.map((row) => row.index), [0], '保留的必须是第一行');
    assert.equal(floor.page.has_more, true, '还有 4 行未返回，has_more 必须为 true');
    assert.equal(floor.page.byte_limited, true, '发生过裁剪，byte_limited 必须为 true');
    assert.equal(floor.page.next_cursor, 'after:0', '续页游标必须指向保留的那一行');
  });
});
