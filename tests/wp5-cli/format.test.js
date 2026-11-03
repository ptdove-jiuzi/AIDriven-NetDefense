/**
 * format.test.js — the one place untrusted text becomes terminal text.
 *
 * These cases are the AT-UI-001 shape applied to a terminal instead of a browser:
 * escape sequences, control characters, bidirectional overrides and dangerous URI
 * schemes must not survive, and the width arithmetic that keeps a table aligned must
 * count columns rather than UTF-16 units.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  displayWidth,
  formatReasons,
  formatUptime,
  padToWidth,
  renderPairs,
  renderTable,
  sanitizeText,
  truncateToWidth,
} from '../../apps/cli/src/format.js';

describe('displayWidth', () => {
  it('counts ASCII as one column per character', () => {
    assert.equal(displayWidth('abc'), 3);
    assert.equal(displayWidth(''), 0);
  });

  it('counts CJK as two columns per character', () => {
    assert.equal(displayWidth('中文'), 4);
    assert.equal(displayWidth('a中'), 3);
  });

  it('counts combining marks as zero columns', () => {
    assert.equal(displayWidth('e\u0301'), 1);
  });

  it('counts emoji as two columns', () => {
    assert.equal(displayWidth('😀'), 2);
    assert.equal(displayWidth('🚀'), 2);
    // U+1F004 (mahjong tile) sits outside the pictograph block that everyone remembers.
    assert.equal(displayWidth('🀄'), 2);
    assert.equal(displayWidth('a😀b'), 4);
  });
});

describe('truncateToWidth', () => {
  it('leaves text that fits untouched', () => {
    assert.equal(truncateToWidth('abc', 3), 'abc');
  });

  it('truncates and appends an ASCII ellipsis within the budget', () => {
    const result = truncateToWidth('abcdef', 5);
    assert.equal(result, 'ab...');
    assert.equal(displayWidth(result), 5);
  });

  it('never splits a wide character in half', () => {
    const result = truncateToWidth('中文字符', 5);
    assert.ok(displayWidth(result) <= 5);
  });

  it('handles a budget smaller than the ellipsis', () => {
    assert.equal(truncateToWidth('abcdef', 2), '..');
  });
});

describe('sanitizeText', () => {
  it('strips a CSI colour sequence', () => {
    assert.equal(sanitizeText('a\u001b[31mred\u001b[0mb'), 'aredb');
  });

  it('strips a CSI clear-screen sequence', () => {
    assert.equal(sanitizeText('a\u001b[2Jb'), 'ab');
  });

  it('strips an OSC title sequence and its terminator', () => {
    assert.equal(sanitizeText('a\u001b]0;owned\u0007b'), 'ab');
    assert.equal(sanitizeText('a\u001b]2;owned\u001b\\b'), 'ab');
  });

  it('strips a two-character escape', () => {
    assert.equal(sanitizeText('a\u001bMb'), 'ab');
  });

  it('removes control characters, including newline and tab', () => {
    assert.equal(sanitizeText('a\nb\tc'), 'a b c');
    assert.equal(sanitizeText('a\u0000b'), 'a b');
    assert.equal(sanitizeText('a\u0085b'), 'a b');
  });

  it('removes bidirectional overrides that spoof a file name', () => {
    assert.equal(sanitizeText('evilexe\u202Egnp.exe'), 'evilexegnp.exe');
  });

  it('blocks dangerous URI schemes', () => {
    assert.equal(sanitizeText('javascript:alert(1)'), '[blocked-uri]');
    assert.equal(sanitizeText('JavaScript:alert(1)'), '[blocked-uri]');
    assert.equal(sanitizeText('data:text/html;base64,AAAA'), '[blocked-uri]');
    assert.equal(sanitizeText('file:///etc/passwd'), '[blocked-uri]');
  });

  it('leaves an ordinary http URL readable', () => {
    assert.equal(sanitizeText('http://127.0.0.1:8443/api/v1/status'), 'http://127.0.0.1:8443/api/v1/status');
  });

  it('truncates to the requested display width', () => {
    const result = sanitizeText('x'.repeat(500), 20);
    assert.equal(displayWidth(result), 20);
    assert.ok(result.endsWith('...'));
  });

  it('renders numbers and booleans', () => {
    assert.equal(sanitizeText(42), '42');
    assert.equal(sanitizeText(true), 'true');
    assert.equal(sanitizeText(false), 'false');
  });

  it('refuses to stringify objects and empties', () => {
    assert.equal(sanitizeText({ a: 1 }), '');
    assert.equal(sanitizeText([1, 2]), '');
    assert.equal(sanitizeText(null), '');
    assert.equal(sanitizeText(undefined), '');
    assert.equal(sanitizeText(Number.NaN), '');
  });

  it('never returns a string containing a control character', () => {
    const sample = '\u001b[31m\u0007\u0000\u001b]0;x\u0007中文\u202E';
    const result = sanitizeText(sample);
    // eslint-disable-next-line no-control-regex
    assert.equal(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e]/u.test(result), false);
  });
});

describe('padToWidth', () => {
  it('pads by display width, not code units', () => {
    assert.equal(padToWidth('中', 4), '中  ');
    assert.equal(padToWidth('ab', 4, 'right'), '  ab');
  });
});

describe('renderTable', () => {
  it('renders a header, a separator and aligned rows', () => {
    const output = renderTable({
      columns: [
        { key: 'id', label: 'id', max: 10 },
        { key: 'n', label: 'n', max: 5, align: 'right' },
      ],
      rows: [{ id: 'a', n: 1 }, { id: 'bb', n: 22 }],
    });
    const lines = output.split('\n');
    assert.equal(lines.length, 4);
    assert.equal(lines[0].startsWith('id'), true);
    assert.match(lines[1], /^-+\s+-+$/u);
    assert.equal(lines[2], 'a    1');
    assert.equal(lines[3], 'bb  22');
  });

  it('keeps columns aligned when a cell contains CJK', () => {
    const output = renderTable({
      columns: [
        { key: 'id', label: 'id', max: 10 },
        { key: 'n', label: 'n', max: 5, align: 'right' },
      ],
      rows: [{ id: '中文', n: 1 }, { id: 'abcd', n: 22 }],
    });
    const [, , first, second] = output.split('\n');
    assert.equal(displayWidth(first), displayWidth(second));
  });

  it('sanitizes every cell', () => {
    const output = renderTable({
      columns: [{ key: 'id', label: 'id', max: 40 }],
      rows: [{ id: '\u001b[2Jpwned' }],
    });
    assert.equal(output.includes('\u001b'), false);
    assert.match(output, /pwned/u);
  });

  it('renders the empty placeholder instead of a bare header', () => {
    const output = renderTable({
      columns: [{ key: 'id', label: 'id' }],
      rows: [],
      empty: '(no rows)',
    });
    assert.equal(output, '(no rows)');
  });
});

describe('renderPairs', () => {
  it('aligns values by label width', () => {
    const output = renderPairs([['a', 1], ['bb', 2]]);
    assert.equal(output, 'a   1\nbb  2');
  });

  it('sanitizes values', () => {
    assert.equal(renderPairs([['x', 'a\u001b[31mb']]), 'x  ab');
  });
});

describe('formatUptime', () => {
  it('renders sub-second durations in milliseconds', () => {
    assert.equal(formatUptime(0), '0ms');
    assert.equal(formatUptime(999), '999ms');
  });

  it('renders seconds, minutes, hours and days', () => {
    assert.equal(formatUptime(1000), '1s');
    assert.equal(formatUptime(61000), '1m 1s');
    assert.equal(formatUptime(3661000), '1h 1m 1s');
    assert.equal(formatUptime(90061000), '1d 1h 1m 1s');
  });

  it('reports an unknown duration instead of inventing one', () => {
    assert.equal(formatUptime(null), 'n/a');
    assert.equal(formatUptime(-1), 'n/a');
    assert.equal(formatUptime('12'), 'n/a');
  });
});

describe('formatReasons', () => {
  it('joins reasons', () => {
    assert.equal(formatReasons(['sources:none', 'store:write-errors']), 'sources:none, store:write-errors');
  });

  it('renders a dash when there is nothing to report', () => {
    assert.equal(formatReasons([]), '-');
  });
});
