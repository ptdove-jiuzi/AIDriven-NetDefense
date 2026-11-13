/**
 * judge.mjs — SEED-04 independent E2E re-attack criteria.
 *
 * Pure functions only: every judgement is computed from raw artefacts this campaign
 * produced itself (`/api/v1/status` samples, independent SQLite probes, daemon log
 * text). Nothing here reads a status file, an evidence directory of another
 * campaign, or any self-report.
 *
 * Field names asserted below were read from the product source before writing the
 * criteria (see REPORT.md §"字段核对"):
 *   - `health.status`, `health.reasons`            apps/daemon/src/health.js:163-167
 *   - `scheduler.sources[].{id,lifecycle,events,accepted,polls,...}`
 *                                                  apps/daemon/src/health.js:170-187
 *   - `counters.rejected_by_store`               apps/daemon/src/daemon.js:372
 *   - `store.stats().events`                     apps/daemon/src/adapters/event-store.js:652-678
 */

/** @typedef {{verdict:'PASS'|'FAIL'|'INFO', detail:string, evidence?:object}} Criterion */

function okSamples(samples) {
  return samples.filter((sample) => sample.http_status === 200 && sample.status !== null);
}

/**
 * Criterion A1: store_events must be non-decreasing and must actually grow.
 *
 * Uses `status.store.events` (the adapter's SQLite `COUNT(*)`) and cross-checks against
 * `counters.events_accepted`; a status payload where the store row count never moves is
 * a hard failure no matter what `health.status` says.
 */
export function judgeStoreGrowth(samples) {
  const rows = okSamples(samples);
  if (rows.length < 2) {
    return { verdict: 'FAIL', detail: `only ${rows.length} authenticated /status samples; cannot judge growth` };
  }
  const series = rows.map((row) => ({
    t_iso: row.t_iso,
    store_events: row.status?.store?.events ?? null,
    events_accepted: row.status?.counters?.events_accepted ?? null,
    events_received: row.status?.counters?.events_received ?? null,
  }));
  const problems = [];
  let previous = null;
  for (const point of series) {
    if (typeof point.store_events !== 'number') {
      problems.push(`sample ${point.t_iso} has no numeric store.events`);
      continue;
    }
    if (previous !== null && point.store_events < previous) {
      problems.push(`store.events decreased ${previous} -> ${point.store_events} at ${point.t_iso}`);
    }
    previous = point.store_events;
  }
  const first = series[0].store_events;
  const last = series[series.length - 1].store_events;
  if (!(typeof last === 'number' && last > 0)) {
    problems.push(`final store.events is ${last}, must be > 0`);
  }
  if (!(typeof first === 'number' && typeof last === 'number' && last > first)) {
    problems.push(`store.events did not grow during the window (first=${first}, last=${last})`);
  }
  // A burst at the start followed by a stall must not pass on `last > first` alone: the
  // stream has to still be growing at the end of the window. This is what makes criterion
  // A1 sensitive to "the first poll landed, then ingestion stopped" (mutation M3).
  const tailIntervals = Math.min(3, series.length - 1);
  const tailStart = series[series.length - 1 - tailIntervals];
  const tailEnd = series[series.length - 1];
  if (!(typeof tailStart?.store_events === 'number'
    && typeof tailEnd?.store_events === 'number'
    && tailEnd.store_events > tailStart.store_events)) {
    problems.push(
      `store.events did not grow across the last ${tailIntervals} sample interval(s) `
      + `(${tailStart?.store_events} -> ${tailEnd?.store_events}): the ingest stream stalled`,
    );
  }
  return {
    verdict: problems.length === 0 ? 'PASS' : 'FAIL',
    detail: problems.length === 0
      ? `store.events ${first} -> ${last} across ${series.length} samples, monotonic non-decreasing`
      : problems.join('; '),
    evidence: { series },
  };
}

/**
 * Criterion A2: the daemon must report `health.status === "ok"` at the end of the
 * sampling window ("ok" is allowed to be reached after transient degradation only if
 * the transient reasons are on record — they are, `samples[]` keeps every payload).
 */
export function judgeHealth(samples) {
  const rows = okSamples(samples);
  if (rows.length === 0) {
    return { verdict: 'FAIL', detail: 'no authenticated /status sample; health unobservable' };
  }
  const final = rows[rows.length - 1];
  const status = final.status?.health?.status ?? null;
  const reasons = final.status?.health?.reasons ?? null;
  const notOk = rows
    .map((row) => ({ t_iso: row.t_iso, status: row.status?.health?.status, reasons: row.status?.health?.reasons }))
    .filter((entry) => entry.status !== 'ok');
  if (status !== 'ok') {
    return {
      verdict: 'FAIL',
      detail: `final health.status=${JSON.stringify(status)} reasons=${JSON.stringify(reasons)}`,
      evidence: { non_ok_samples: notOk },
    };
  }
  return {
    verdict: 'PASS',
    detail: `final health.status=ok; ${notOk.length}/${rows.length} samples were transiently non-ok (all reasons kept in SAMPLES/)`,
    evidence: { non_ok_samples: notOk },
  };
}

/**
 * Criterion A3: no source may be reported `ok` while it has produced zero events.
 *
 * This is the exact old defect ("0 条却 ok"). `lifecycle` is the daemon's honest
 * per-source view (daemon.js sourceStatusView); `events` is the scheduler's cumulative
 * count of events the source returned.
 */
export function judgePerSource(samples) {
  const rows = okSamples(samples);
  if (rows.length === 0) {
    return { verdict: 'FAIL', detail: 'no authenticated /status sample; per-source view unobservable' };
  }
  const violations = [];
  const zeroEventSources = new Map();
  const emptyReasonVisible = new Set();
  for (const row of rows) {
    const sources = row.status?.scheduler?.sources ?? [];
    for (const source of sources) {
      const lifecycle = source?.lifecycle ?? null;
      const events = typeof source?.events === 'number' ? source.events : null;
      if (lifecycle === 'ok' && (events === 0 || source?.accepted === 0 && source?.polls === 0)) {
        violations.push({ t_iso: row.t_iso, id: source.id, lifecycle, events, accepted: source.accepted, polls: source.polls });
      }
      if (events === 0) {
        const previous = zeroEventSources.get(source.id) ?? { id: source.id, first_seen: row.t_iso, last_lifecycle: null, samples_zero: 0 };
        previous.last_lifecycle = lifecycle;
        previous.samples_zero += 1;
        zeroEventSources.set(source.id, previous);
      }
      // The explicit empty classification would live in `last_empty_code` / `last_empty_reason`
      // (daemon.js:402-403). Record whether the API actually carries it.
      if (source?.last_empty_code !== undefined || source?.last_empty_reason !== undefined) {
        emptyReasonVisible.add(source.id);
      }
    }
  }
  const finalSources = (rows[rows.length - 1].status?.scheduler?.sources ?? []).map((source) => ({
    id: source.id,
    lifecycle: source.lifecycle,
    events: source.events,
    accepted: source.accepted,
    polls: source.polls,
    failures: source.failures,
    stale: source.stale,
    last_error_code: source.last_error_code,
  }));
  return {
    verdict: violations.length === 0 ? 'PASS' : 'FAIL',
    detail: violations.length === 0
      ? `no source reported ok with zero events across ${rows.length} samples (${finalSources.length} sources)`
      : `${violations.length} (source, sample) pairs report lifecycle=ok with events=0`,
    evidence: {
      violations,
      final_sources: finalSources,
      zero_event_sources: [...zeroEventSources.values()],
      last_empty_code_exposed_by_api: emptyReasonVisible.size > 0,
      last_empty_code_note: emptyReasonVisible.size > 0
        ? 'API exposes last_empty_code/last_empty_reason'
        : 'API does NOT expose last_empty_code/last_empty_reason even though daemon.js computes them (observability gap)',
    },
  };
}

/**
 * Criterion A4: `/status.store.events` versus an independent `SELECT COUNT(*)` read.
 *
 * The status counter is cached for up to 1 s (adapters/event-store.js:46), so the DB may
 * legitimately be ahead by the writes that landed between the two reads. What must never
 * happen is a status count larger than the DB, or a mismatch that keeps growing.
 */
export function judgeDatabase(samples, dbReads, { maxLead = 500 } = {}) {
  const rows = okSamples(samples);
  if (rows.length === 0 || dbReads.length === 0) {
    return { verdict: 'FAIL', detail: 'missing /status samples or independent DB probes' };
  }
  const usable = dbReads.filter((probe) => probe.ok === true);
  if (usable.length === 0) {
    return { verdict: 'FAIL', detail: `all ${dbReads.length} independent DB probes failed: ${dbReads[0]?.error ?? 'unknown'}` };
  }
  const problems = [];
  const pairs = [];
  for (const probe of usable) {
    // Prefer the index pairing (sample N was taken immediately before probe N); fall back
    // to the latest authenticated sample at or before the probe when indices are absent.
    let sample = null;
    if (typeof probe.index === 'number') {
      sample = rows.find((row) => row.index === probe.index) ?? null;
    }
    if (sample === null) {
      for (const row of rows) {
        if (typeof row.t_ms === 'number' && typeof probe.t_ms === 'number' && row.t_ms <= probe.t_ms) {
          sample = row;
        }
      }
    }
    if (sample === null) {
      continue;
    }
    const statusCount = sample.status?.store?.events ?? null;
    const dbCount = probe.count;
    const delta = typeof statusCount === 'number' ? dbCount - statusCount : null;
    pairs.push({
      sample_t: sample.t_iso,
      probe_t: probe.t_iso,
      status_store_events: statusCount,
      db_count: dbCount,
      delta_db_minus_status: delta,
      null_boot: probe.null_boot,
      null_integrity: probe.null_integrity,
      distinct_boot_ids: probe.distinct_boot_ids,
      max_ingest_seq: probe.max_ingest_seq,
    });
    if (typeof statusCount !== 'number') {
      problems.push(`sample ${sample.t_iso} has no numeric store.events to compare`);
      continue;
    }
    if (delta < 0) {
      problems.push(`status.store.events (${statusCount}) EXCEEDS DB rows (${dbCount}) at ${sample.t_iso}`);
    } else if (delta > maxLead) {
      problems.push(`DB is ${delta} rows ahead of status.store.events at ${sample.t_iso} (allowed lead ${maxLead})`);
    }
    if (probe.null_boot !== 0) {
      problems.push(`${probe.null_boot} telemetry_event rows have NULL boot_id`);
    }
    if (probe.null_integrity !== 0) {
      problems.push(`${probe.null_integrity} telemetry_event rows have NULL integrity_digest`);
    }
  }
  const finalProbe = usable[usable.length - 1];
  if (finalProbe.count <= 0) {
    problems.push(`final independent DB COUNT(*) is ${finalProbe.count}`);
  }
  return {
    verdict: problems.length === 0 ? 'PASS' : 'FAIL',
    detail: problems.length === 0
      ? `status.store.events tracks independent COUNT(*) within [0,+${maxLead}] rows over ${pairs.length} paired probes; boot_id/integrity_digest non-NULL`
      : problems.join('; '),
    evidence: {
      pairs,
      final_db: {
        count: finalProbe.count,
        null_boot: finalProbe.null_boot,
        null_integrity: finalProbe.null_integrity,
        distinct_boot_ids: finalProbe.distinct_boot_ids,
        journal_mode: finalProbe.journal_mode,
      },
    },
  };
}

/**
 * Criterion B1: a store-rejected write must surface in `counters.rejected_by_store`.
 *
 * Absence of the counter (`undefined`) is not the same as `0`: an unobservable counter is
 * reported as FAIL with a distinct detail so the report can classify it as an
 * observability defect instead of a "nothing was rejected" pass.
 */
export function judgeRejectedCounter(samples) {
  const rows = okSamples(samples);
  if (rows.length === 0) {
    return { verdict: 'FAIL', detail: 'no authenticated /status sample; rejected counter unobservable' };
  }
  const values = rows.map((row) => ({
    t_iso: row.t_iso,
    rejected_by_store: row.status?.counters?.rejected_by_store,
  }));
  const final = values[values.length - 1].rejected_by_store;
  if (final === undefined) {
    return {
      verdict: 'FAIL',
      kind: 'UNOBSERVABLE',
      detail: 'counters.rejected_by_store is absent from /api/v1/status',
      evidence: { values },
    };
  }
  if (typeof final !== 'number' || final <= 0) {
    return {
      verdict: 'FAIL',
      kind: 'COUNTER_ZERO',
      detail: `counters.rejected_by_store=${JSON.stringify(final)} after deliberately invalid events`,
      evidence: { values },
    };
  }
  return {
    verdict: 'PASS',
    detail: `counters.rejected_by_store=${final} (grew from ${values[0].rejected_by_store})`,
    evidence: { values },
  };
}

/** Criterion B2: is the rejection *distribution* (`by_reason`) reachable over the API? */
export function judgeRejectionReasons(samples, logText = '') {
  const rows = okSamples(samples);
  const finalPayload = rows.length === 0 ? null : rows[rows.length - 1].status;
  const serialized = finalPayload === null ? '' : JSON.stringify(finalPayload);
  const apiExposes = /"by_reason"|by_reason|store_reject_reason/.test(serialized);
  const logReasons = new Set();
  for (const line of String(logText).split(/\r?\n/)) {
    if (!line.includes('event store rejected a write')) {
      continue;
    }
    try {
      const record = JSON.parse(line);
      logReasons.add(String(record.reason ?? record.code ?? 'UNKNOWN'));
    } catch {
      logReasons.add('UNPARSEABLE_LOG_LINE');
    }
  }
  return {
    verdict: apiExposes ? 'PASS' : 'FAIL',
    kind: apiExposes ? null : 'OBSERVABILITY_GAP',
    detail: apiExposes
      ? 'API payload carries a by_reason/store_reject_reason distribution'
      : `API payload carries NO by_reason/store_reject_reason field (daemon.js:301 accumulates storeRejection.by_reason, daemon.js:372 only exposes .count); rejection reasons visible only in the daemon log: ${JSON.stringify([...logReasons])}`,
    evidence: {
      api_exposes_by_reason: apiExposes,
      counter_field: finalPayload?.counters?.rejected_by_store ?? null,
      log_reason_buckets: [...logReasons],
    },
  };
}

/** Criterion B3: the source whose events are rejected must not be reported `ok`. */
export function judgeRejectingSourceNotOk(samples, suspectIds = ['seed04.reject']) {
  const rows = okSamples(samples);
  if (rows.length === 0) {
    return { verdict: 'FAIL', detail: 'no authenticated /status sample' };
  }
  const final = rows[rows.length - 1];
  const sources = final.status?.scheduler?.sources ?? [];
  const assessed = sources
    .filter((source) => suspectIds.includes(source.id))
    .map((source) => ({
      id: source.id,
      lifecycle: source.lifecycle,
      events: source.events,
      accepted: source.accepted,
      failures: source.failures,
      last_error_code: source.last_error_code,
    }));
  const bad = assessed.filter((source) => source.lifecycle === 'ok');
  const healthStatus = final.status?.health?.status ?? null;
  const reasons = final.status?.health?.reasons ?? [];
  const problems = [];
  if (assessed.length === 0) {
    problems.push(`suspect source(s) ${suspectIds.join(',')} absent from /status`);
  }
  for (const source of bad) {
    problems.push(`source ${source.id} is reported ok despite rejected writes`);
  }
  if (healthStatus === 'ok') {
    problems.push('health.status is ok while the event store is rejecting writes');
  }
  const storeErrorsReason = reasons.some((reason) => String(reason).startsWith('store:'));
  return {
    verdict: problems.length === 0 ? 'PASS' : 'FAIL',
    detail: problems.length === 0
      ? `suspect source lifecycle=${JSON.stringify(assessed.map((source) => source.lifecycle))}; health.status=${healthStatus} reasons=${JSON.stringify(reasons)}`
      : problems.join('; '),
    evidence: { assessed, health_status: healthStatus, health_reasons: reasons, store_reason_present: storeErrorsReason },
  };
}

/**
 * Criterion A5 (used by mutations M1/M3): every non-ok lifecycle must be an explicit,
 * named state — an `unavailable` source must carry an error code, an `empty` source must
 * explain itself (in the payload, or the gap is recorded separately).
 */
export function judgeLifecycleHonesty(samples) {
  const rows = okSamples(samples);
  if (rows.length === 0) {
    return { verdict: 'FAIL', detail: 'no authenticated /status sample' };
  }
  const final = rows[rows.length - 1];
  const sources = final.status?.scheduler?.sources ?? [];
  const rowsWithState = sources.map((source) => ({
    id: source.id,
    lifecycle: source.lifecycle,
    events: source.events,
    last_error_code: source.last_error_code ?? null,
    stale: source.stale,
  }));
  const unknown = rowsWithState.filter((source) => !['ok', 'empty', 'degraded', 'unavailable', 'polling', 'idle', 'stopped'].includes(source.lifecycle));
  const unavailableWithoutCode = rowsWithState.filter((source) => source.lifecycle === 'unavailable' && source.last_error_code === null);
  const problems = [
    ...unknown.map((source) => `source ${source.id} has unknown lifecycle ${JSON.stringify(source.lifecycle)}`),
    ...unavailableWithoutCode.map((source) => `source ${source.id} is unavailable with no last_error_code`),
  ];
  return {
    verdict: problems.length === 0 ? 'PASS' : 'FAIL',
    detail: problems.length === 0 ? `lifecycles=${JSON.stringify(rowsWithState.map((source) => `${source.id}:${source.lifecycle}`))}` : problems.join('; '),
    evidence: { final_sources: rowsWithState },
  };
}

/** Aggregate the A-criteria into the campaign three-state verdict. */
export function judgeRealRun(samples, dbReads) {
  const criteria = [
    { id: 'A1.store_events_monotonic_and_growing', ...judgeStoreGrowth(samples) },
    { id: 'A2.health_status_ok', ...judgeHealth(samples) },
    { id: 'A3.no_source_zero_events_but_ok', ...judgePerSource(samples) },
    { id: 'A4.db_count_cross_check', ...judgeDatabase(samples, dbReads) },
    { id: 'A5.lifecycle_honesty', ...judgeLifecycleHonesty(samples) },
  ];
  const failed = criteria.filter((criterion) => criterion.verdict === 'FAIL');
  return {
    criteria,
    verdict: failed.length === 0 ? 'CLOSED' : 'BYPASSED',
    failed: failed.map((criterion) => criterion.id),
  };
}

/**
 * Aggregate the criteria that do not need a SQLite probe (fixture runs / mutations).
 *
 * A4 is omitted because a short fixture run does not perform independent DB reads; A1,
 * A2, A3 and A5 are exactly the criteria that mutations M1/M3 are supposed to flip.
 */
export function judgeSourceRun(samples) {
  const criteria = [
    { id: 'A1.store_events_monotonic_and_growing', ...judgeStoreGrowth(samples) },
    { id: 'A2.health_status_ok', ...judgeHealth(samples) },
    { id: 'A3.no_source_zero_events_but_ok', ...judgePerSource(samples) },
    { id: 'A5.lifecycle_honesty', ...judgeLifecycleHonesty(samples) },
  ];
  const failed = criteria.filter((criterion) => criterion.verdict === 'FAIL');
  return {
    criteria,
    verdict: failed.length === 0 ? 'CLOSED' : 'BYPASSED',
    failed: failed.map((criterion) => criterion.id),
  };
}

/** Aggregate the B-criteria. */
export function judgeRejectionRun(samples, logText, { suspectIds } = {}) {
  const criteria = [
    { id: 'B1.rejected_by_store_counter', ...judgeRejectedCounter(samples) },
    { id: 'B2.by_reason_distribution_observable', ...judgeRejectionReasons(samples, logText) },
    { id: 'B3.rejecting_source_not_ok', ...judgeRejectingSourceNotOk(samples, suspectIds) },
  ];
  // B2 is an observability criterion: its failure is a new finding, not a bypass of the
  // core "rejections are not silently swallowed" property. B1 and B3 are the core.
  const core = criteria.filter((criterion) => criterion.id !== 'B2.by_reason_distribution_observable');
  const coreFailed = core.filter((criterion) => criterion.verdict === 'FAIL');
  return {
    criteria,
    verdict: coreFailed.length === 0 ? 'CLOSED' : 'BYPASSED',
    failed: coreFailed.map((criterion) => criterion.id),
    new_findings: criteria.filter((criterion) => criterion.verdict === 'FAIL' && criterion.id === 'B2.by_reason_distribution_observable'),
  };
}
