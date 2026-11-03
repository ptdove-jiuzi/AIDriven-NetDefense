/**
 * views.js — stable view model → human text.
 *
 * Rules:
 *
 * 1. **No colour, ever.** ANSI is the vector the design forbids, and emitting it from
 *    the one component that is supposed to be safe would make every downstream log
 *    the CLI writes into a place where escape sequences arrive from a trusted source.
 * 2. **Curated fields only.** A renderer never iterates the raw payload; it reads the
 *    names it knows. Text is already sanitized by `projectX`, and is sanitized again
 *    on the way through `renderTable` / `renderPairs`, which is cheap and removes any
 *    chance of a new field reaching the terminal unsanitized.
 * 3. **Say "unknown", not blank.** A missing value prints `-` rather than an empty
 *    column, so a missing field looks like a missing field instead of a zero.
 */

import { formatReasons, formatUptime, renderPairs, renderTable } from './format.js';

function orDash(value) {
  return value === null || value === undefined || value === '' ? '-' : value;
}

/**
 * Render the `status` command.
 *
 * @param {object} view Projected status.
 * @returns {string} Human text.
 */
export function renderStatus(view) {
  const lines = [];
  lines.push(`daemon   ${orDash(view.daemon.version)}  mode=${orDash(view.daemon.mode)}  lifecycle=${orDash(view.daemon.lifecycle)}  uptime=${formatUptime(view.daemon.uptime_ms)}`);
  lines.push(`health   ${orDash(view.health.status)}  ready=${view.health.ready ? 'yes' : 'no'}`);
  lines.push(`reasons  ${formatReasons(view.health.reasons)}`);
  if (view.daemon.epoch !== null) {
    lines.push(`epoch    ${view.daemon.epoch}`);
  }
  if (view.daemon.started_at !== null) {
    lines.push(`started  ${view.daemon.started_at}`);
  }

  lines.push('');
  lines.push('sources');
  lines.push(renderTable({
    columns: [
      { key: 'id', label: 'id', max: 36 },
      { key: 'kind', label: 'kind', max: 18 },
      { key: 'lifecycle', label: 'lifecycle', max: 10 },
      { key: 'polls', label: 'polls', max: 7, align: 'right' },
      { key: 'events', label: 'events', max: 8, align: 'right' },
      { key: 'accepted', label: 'accepted', max: 8, align: 'right' },
      { key: 'consecutive_failures', label: 'fails', max: 5, align: 'right' },
      { key: 'last_error_code', label: 'last_error', max: 20 },
    ],
    rows: view.scheduler.sources,
    empty: '(no sources configured)',
  }));

  const schedulerPairs = Object.entries(view.scheduler)
    .filter(([key]) => key !== 'sources');
  if (schedulerPairs.length > 0) {
    lines.push('');
    lines.push('scheduler');
    lines.push(renderPairs(schedulerPairs));
  }

  const pipelinePairs = Object.entries(view.pipeline)
    .filter(([, value]) => value !== null && typeof value !== 'object');
  if (pipelinePairs.length > 0) {
    lines.push('');
    lines.push('pipeline');
    lines.push(renderPairs(pipelinePairs));
  }

  lines.push('');
  lines.push('store');
  lines.push(renderPairs([
    ['kind', orDash(view.store.kind)],
    ['open', view.store.open ? 'yes' : 'no'],
    ...Object.entries(view.store.counts),
  ]));

  if (Object.keys(view.counters).length > 0) {
    lines.push('');
    lines.push('counters');
    lines.push(renderTable({
      columns: [
        { key: 'name', label: 'counter', max: 28 },
        { key: 'value', label: 'value', max: 20, align: 'right' },
      ],
      rows: Object.entries(view.counters).map(([name, value]) => ({ name, value: orDash(value) })),
    }));
  }

  return lines.join('\n');
}

/**
 * Render the `health` command.
 *
 * @param {object} view Projected health.
 * @returns {string} Human text.
 */
export function renderHealth(view) {
  return [
    `liveness   ${orDash(view.liveness.status)}  http=${view.liveness.http_status}  version=${orDash(view.liveness.version)}`,
    `readiness  ready=${view.readiness.ready ? 'yes' : 'no'}  lifecycle=${orDash(view.readiness.lifecycle)}  http=${view.readiness.http_status}`,
    `reasons    ${formatReasons(view.readiness.reasons)}`,
  ].join('\n');
}

/**
 * Render the summary line above a list.
 *
 * `page` is the only account of the page, so the header repeats it verbatim instead of
 * deriving a story from the row count: `returned` is what the daemon says it sent,
 * `has_more` says whether there is more, and `byte_limited` says the response was cut to
 * fit the byte cap. Deriving "more" from `rows.length === limit` used to hide a
 * byte-limited page, which has fewer rows *and* more data.
 *
 * `pages` appears only when a `--all` walk actually merged more than one page: printing
 * `pages=1` on every single-page read would add a column that never varies. `truncated`
 * appears only when the walk stopped at the page cap with rows still unread — a state
 * `has_more` alone cannot express, because `has_more` describes the daemon and
 * `truncated` describes this invocation.
 *
 * @param {string} label Row label.
 * @param {{limit: number, returned: number, has_more: boolean, byte_limited: boolean, order: string, pages?: number, truncated?: boolean}} view List view.
 * @returns {string} Header line.
 */
function renderListHeader(label, view) {
  const parts = [
    `${label}   returned=${view.returned}`,
    `limit=${view.limit}`,
    `order=${orDash(view.order)}`,
    `has_more=${view.has_more === true ? 'yes' : 'no'}`,
  ];
  if (typeof view.pages === 'number' && view.pages > 1) {
    parts.push(`pages=${view.pages}`);
  }
  if (view.truncated === true) {
    parts.push('truncated=yes');
  }
  if (view.byte_limited === true) {
    parts.push('byte_limited=yes');
  }
  return parts.join('  ');
}

/**
 * The one line of advice a `has_more=yes` page gets.
 *
 * It deliberately does **not** spell out a whole command line. The cursor is printed
 * separately (see the callers) and the advice is the *delta*: add `--cursor` to the
 * command you just ran. That is always correct and it is the only wording that is:
 * a printed `aegis-cli alerts --limit 2 --cursor …` would be missing whatever else the
 * invocation needed — `--config`, `--timeout`, `--json` — and would therefore fail the
 * moment an operator pasted it. The flag that was typed is already in their shell
 * history; the one thing they do not have is the cursor.
 *
 * Two other wordings cover the cases where "add --cursor" is not the answer: a walk that
 * stopped at `--max-pages` says so first, and a page whose cursor the daemon failed to
 * send says that instead of pointing at a flag with nothing to pass it.
 *
 * @param {object} view List view.
 * @returns {string} Note text, without the `note` label.
 */
function moreRowsNote(view) {
  const continuable = typeof view.next_cursor === 'string' && view.next_cursor.length > 0;
  const advice = continuable
    ? 'continue with the same command plus --cursor (value below)'
    : 'the daemon sent no cursor, so this page cannot be continued';
  if (view.truncated === true) {
    return `stopped after ${view.pages} pages (--max-pages); more rows are available — ${advice}`;
  }
  return `more rows are available — ${advice}`;
}

/**
 * Whether a list view carries a cursor worth printing.
 *
 * @param {object} view List view.
 * @returns {boolean} `true` when `next_cursor` is a non-empty string.
 */
function hasCursor(view) {
  return typeof view.next_cursor === 'string' && view.next_cursor.length > 0;
}

/**
 * Render the `alerts` command.
 *
 * @param {object} view Projected alerts.
 * @returns {string} Human text.
 */
export function renderAlerts(view) {
  const lines = [
    renderListHeader('alerts', view),
    '',
    renderTable({
      columns: [
        { key: 'alert_id', label: 'alert_id', max: 24 },
        { key: 'rule_id', label: 'rule_id', max: 24 },
        { key: 'severity', label: 'severity', max: 10 },
        { key: 'status', label: 'status', max: 12 },
        { key: 'count', label: 'count', max: 6, align: 'right' },
        { key: 'evidence_count', label: 'evidence_count', max: 14, align: 'right' },
        { key: 'last_seen', label: 'last_seen', max: 24 },
      ],
      rows: view.items,
      empty: '(no alerts returned)',
    }),
  ];
  if (view.has_more === true) {
    lines.push('');
    lines.push(`note     ${moreRowsNote(view)}`);
    if (hasCursor(view)) {
      // Printed in full and unquoted: the cursor is opaque, so shortening it to fit a
      // column would produce a value that fails, and there is nothing in it to hide.
      lines.push(`cursor   ${view.next_cursor}`);
    }
  }
  return lines.join('\n');
}

/**
 * Render the `analysis` command.
 *
 * @param {object} view Projected analysis list or single job.
 * @returns {string} Human text.
 */
export function renderAnalysis(view) {
  if (typeof view.id === 'string') {
    return [
      `analysis   ${view.id}`,
      '',
      renderPairs([
        ['alert_id', orDash(view.item.alert_id)],
        ['state', orDash(view.item.state)],
        ['budget_class', orDash(view.item.budget_class)],
        ['attempts', orDash(view.item.attempts)],
        ['created_at', orDash(view.item.created_at)],
        ['updated_at', orDash(view.item.updated_at)],
        ['completed_at', orDash(view.item.completed_at)],
        ['report_available', view.item.report_available === true ? 'yes' : 'no'],
      ]),
    ].join('\n');
  }
  const lines = [
    renderListHeader('analysis', view),
    '',
    renderTable({
      columns: [
        { key: 'analysis_id', label: 'analysis_id', max: 24 },
        { key: 'alert_id', label: 'alert_id', max: 24 },
        { key: 'state', label: 'state', max: 14 },
        { key: 'budget_class', label: 'budget_class', max: 12 },
        { key: 'attempts', label: 'attempts', max: 8, align: 'right' },
        { key: 'report_available', label: 'report_available', max: 16 },
        { key: 'updated_at', label: 'updated_at', max: 24 },
      ],
      rows: view.items.map((item) => ({ ...item, report_available: item.report_available === true ? 'yes' : 'no' })),
      empty: '(no analysis jobs returned)',
    }),
  ];
  if (view.has_more === true) {
    lines.push('');
    lines.push(`note     ${moreRowsNote(view)}`);
    if (hasCursor(view)) {
      lines.push(`cursor   ${view.next_cursor}`);
    }
  }
  return lines.join('\n');
}
