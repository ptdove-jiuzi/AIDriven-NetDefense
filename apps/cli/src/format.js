/**
 * format.js — the only place daemon text becomes terminal text.
 *
 * Everything the daemon (or a future mock, or an attacker who got between them)
 * sends is untrusted. The design forbids rendering untrusted text as anything but
 * plain text: no raw HTML, no dangerous URI, no remote resource, no ANSI control
 * sequence. A CLI that prints a server string verbatim violates all four at once —
 * `ESC [ 2 J` clears the operator's screen, `ESC ] 0 ; ... BEL` retitles the window,
 * and a right-to-left override makes `evil\u202Egnp.exe` display as `evilexe.png`.
 *
 * So there is exactly one sanitizer, it runs on every string in both output modes,
 * and it is applied *before* width calculation (otherwise a stripped escape
 * sequence would still consume column space).
 *
 * The same rule applies to alignment: `String.prototype.padEnd` counts UTF-16 code
 * units, so a CJK label would silently shift every column after it. Widths here are
 * display widths.
 */

/** Escape sequences, longest form first. */
const ESCAPE_SEQUENCES = Object.freeze([
  /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/gu, // OSC … BEL / ST
  /\u001b\[[0-?]*[ -/]*[@-~]/gu, // CSI … final byte
  /\u001b[()#][0-9A-Za-z]/gu, // charset designation
  /\u001b[@-Z\\-_]/gu, // two-character escapes
]);

/** C0 and C1 controls, including ESC itself, tab, CR and LF. */
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/gu;

/** Bidirectional overrides and isolates: the classic filename-spoofing vector. */
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

/** URI schemes that must never be presented as something a terminal could act on. */
const DANGEROUS_URI = /^(?:javascript|data|vbscript|file|blob|about):/iu;

/** Ranges that occupy two terminal columns. */
const WIDE_RANGES = Object.freeze([
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f000, 0x1f2ff],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x3fffd],
]);

/** Ranges that occupy no columns. */
const ZERO_WIDTH_RANGES = Object.freeze([
  [0x0300, 0x036f],
  [0x1ab0, 0x1aff],
  [0x200b, 0x200f],
  [0xfe00, 0xfe0f],
  [0xfe20, 0xfe2f],
]);

function inRanges(codePoint, ranges) {
  for (const [low, high] of ranges) {
    if (codePoint >= low && codePoint <= high) {
      return true;
    }
  }
  return false;
}

/**
 * Terminal display width of a string.
 *
 * @param {string} text Input.
 * @returns {number} Columns occupied.
 */
export function displayWidth(text) {
  let width = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (inRanges(codePoint, ZERO_WIDTH_RANGES)) {
      continue;
    }
    width += inRanges(codePoint, WIDE_RANGES) ? 2 : 1;
  }
  return width;
}

/**
 * Truncate to a maximum display width, appending `...` when shortened.
 *
 * @param {string} text Input.
 * @param {number} maxWidth Maximum columns.
 * @returns {string} Truncated text.
 */
export function truncateToWidth(text, maxWidth) {
  if (displayWidth(text) <= maxWidth) {
    return text;
  }
  if (maxWidth <= 3) {
    return '.'.repeat(Math.max(0, maxWidth));
  }
  const budget = maxWidth - 3;
  let width = 0;
  let output = '';
  for (const character of text) {
    const characterWidth = displayWidth(character);
    if (width + characterWidth > budget) {
      break;
    }
    output += character;
    width += characterWidth;
  }
  return `${output}...`;
}

/**
 * Sanitize one untrusted scalar into a single printable line.
 *
 * Numbers and booleans pass through untouched; `null`/`undefined` become an empty
 * string; objects are refused rather than stringified (a JSON blob in a table cell
 * is never what the operator wanted, and `[object Object]` hides a bug).
 *
 * @param {unknown} value Candidate value.
 * @param {number} [maxWidth] Maximum display width, default 200.
 * @returns {string} Printable text.
 */
export function sanitizeText(value, maxWidth = 200) {
  if (value === null || value === undefined) {
    return '';
  }
  let text;
  if (typeof value === 'string') {
    text = value;
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    text = String(value);
  } else if (typeof value === 'boolean') {
    text = value ? 'true' : 'false';
  } else {
    return '';
  }
  for (const pattern of ESCAPE_SEQUENCES) {
    text = text.replace(pattern, '');
  }
  text = text.replace(CONTROLS, ' ').replace(BIDI_CONTROLS, '');
  text = text.replace(/\s+/gu, ' ').trim();
  if (DANGEROUS_URI.test(text)) {
    return '[blocked-uri]';
  }
  return truncateToWidth(text, maxWidth);
}

/**
 * Sanitize a value for the JSON view.
 *
 * JSON already escapes control characters, but it does *not* neutralise bidi
 * overrides or ANSI sequences, and a log consumer may well dump the JSON straight
 * into a terminal. Same rules, one code path.
 *
 * @param {unknown} value Candidate value.
 * @returns {string|null} Sanitized string, or `null` when absent.
 */
export function sanitizeNullable(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const text = sanitizeText(value, 400);
  return text.length === 0 ? null : text;
}

/**
 * Pad a string to a display width.
 *
 * @param {string} text Already-sanitized text.
 * @param {number} width Target width.
 * @param {'left'|'right'} [align] Padding side.
 * @returns {string} Padded text.
 */
export function padToWidth(text, width, align = 'left') {
  const padding = Math.max(0, width - displayWidth(text));
  return align === 'right' ? `${' '.repeat(padding)}${text}` : `${text}${' '.repeat(padding)}`;
}

/**
 * Render a table with display-width alignment.
 *
 * @param {{
 *   columns: readonly {key: string, label: string, max?: number, align?: 'left'|'right'}[],
 *   rows: readonly Record<string, unknown>[],
 *   empty?: string
 * }} table Table definition.
 * @returns {string} Rendered table, no trailing newline.
 */
export function renderTable(table) {
  if (table.rows.length === 0) {
    return table.empty ?? '(none)';
  }
  const cells = table.rows.map((row) => table.columns.map((column) => sanitizeText(
    row[column.key],
    column.max ?? 40,
  )));
  const widths = table.columns.map((column, index) => {
    const headerWidth = displayWidth(column.label);
    const cellWidth = cells.reduce((widest, row) => Math.max(widest, displayWidth(row[index])), 0);
    return Math.max(headerWidth, cellWidth);
  });
  const header = table.columns
    .map((column, index) => padToWidth(column.label, widths[index], column.align ?? 'left'))
    .join('  ');
  const separator = widths.map((width) => '-'.repeat(width)).join('  ');
  const body = cells.map((row) => row
    .map((cell, index) => padToWidth(cell, widths[index], table.columns[index].align ?? 'left'))
    .join('  '));
  return [header, separator, ...body].join('\n');
}

/**
 * Render `label: value` lines with aligned labels.
 *
 * @param {readonly [string, unknown][]} pairs Label/value pairs.
 * @returns {string} Rendered block.
 */
export function renderPairs(pairs) {
  const rows = pairs.map(([label, value]) => [label, sanitizeText(value, 200)]);
  const width = rows.reduce((widest, [label]) => Math.max(widest, displayWidth(label)), 0);
  return rows.map(([label, value]) => `${padToWidth(label, width)}  ${value}`).join('\n');
}

/**
 * Render a duration in milliseconds as a compact human string.
 *
 * @param {unknown} value Milliseconds.
 * @returns {string} e.g. `2d 3h`, `41s`, `n/a`.
 */
export function formatUptime(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 'n/a';
  }
  const totalSeconds = Math.floor(value / 1000);
  if (totalSeconds < 1) {
    return `${Math.floor(value)}ms`;
  }
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (days > 0 || hours > 0) {
    parts.push(`${hours}h`);
  }
  if (days > 0 || hours > 0 || minutes > 0) {
    parts.push(`${minutes}m`);
  }
  parts.push(`${seconds}s`);
  return parts.join(' ');
}

/**
 * Render a list of reasons as one comma-separated line.
 *
 * @param {readonly string[]} reasons Already-sanitized reasons.
 * @returns {string} Rendered line, or `-` when empty.
 */
export function formatReasons(reasons) {
  return reasons.length === 0 ? '-' : reasons.map((reason) => sanitizeText(reason, 80)).join(', ');
}
