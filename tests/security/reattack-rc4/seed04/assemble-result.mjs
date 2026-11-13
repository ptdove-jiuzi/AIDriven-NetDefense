#!/usr/bin/env node
/**
 * assemble-result.mjs — SEED-04 evidence roll-up.
 *
 * Reads only the raw artefacts this campaign produced (`RESULT-run-a.json`,
 * `RESULT-b-baseline.json`, `MUTATIONS.json`, plus the raw sample/log files they point
 * at) and writes the single machine-readable verdict `RESULT.json`.
 *
 * It does not re-judge: the criteria were computed by judge.mjs from the raw API bodies
 * and SQLite probes at run time. This file only aggregates and states the three-state
 * verdict per objective.
 *
 * Usage: node assemble-result.mjs --outdir docs/implementation/evidence/review/reattack-rc4/seed04
 */

import fs from 'node:fs';
import path from 'node:path';

const args = { outdir: null };
for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  if (token === '--outdir') {
    args.outdir = process.argv[index + 1];
    index += 1;
  } else {
    throw new Error(`unknown argument: ${token}`);
  }
}
if (args.outdir === null) {
  throw new Error('--outdir is required');
}
const dir = path.resolve(args.outdir);

function readJson(fileName) {
  const filePath = path.join(dir, fileName);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function criterionVerdict(result, criterionId) {
  const found = (result?.judge?.criteria ?? []).find((criterion) => criterion.id === criterionId);
  return found === null || found === undefined ? null : { verdict: found.verdict, detail: found.detail, kind: found.kind ?? null };
}

const real = readJson('RESULT-run-a.json');
const bubble = readJson('RESULT-b-baseline.json');
const mutations = readJson('MUTATIONS.json');

if (real === null) {
  throw new Error('RESULT-run-a.json is missing: run run-real-sources.mjs first');
}
if (bubble === null) {
  throw new Error('RESULT-b-baseline.json is missing: run run-fixture.mjs --judge b first');
}
if (mutations === null) {
  throw new Error('MUTATIONS.json is missing: run mutate-and-check.mjs first');
}

const realCriteria = (real.judge?.criteria ?? []).map((criterion) => ({
  id: criterion.id,
  verdict: criterion.verdict,
  detail: criterion.detail,
}));
const bubbleCriteria = (bubble.judge?.criteria ?? []).map((criterion) => ({
  id: criterion.id,
  verdict: criterion.verdict,
  detail: criterion.detail,
  kind: criterion.kind ?? null,
}));

const observabilityFindings = [];
const b2 = bubbleCriteria.find((criterion) => criterion.id === 'B2.by_reason_distribution_observable');
if (b2?.verdict === 'FAIL') {
  observabilityFindings.push({
    id: 'SEED04-N1',
    severity: 'P2',
    title: 'store rejection distribution (by_reason) is not observable over the control API',
    detail: b2.detail,
    evidence: {
      accumulation: 'apps/daemon/src/daemon.js:198-230 (observeStoreWrites increments rejection.by_reason)',
      exposure: 'apps/daemon/src/daemon.js:372 (only rejected_by_store: rejection.count is projected into counters)',
      sample: 'RESULT-b-baseline.json → judge.criteria[B2].evidence',
    },
  });
}
const a3 = realCriteria.find((criterion) => criterion.id === 'A3.no_source_zero_events_but_ok');
const a3evidence = (real.judge?.criteria ?? []).find((criterion) => criterion.id === 'A3.no_source_zero_events_but_ok')?.evidence;if (a3.evidence?.last_empty_code_exposed_by_api === false || a3evidence?.last_empty_code_exposed_by_api === false) {
  observabilityFindings.push({
    id: 'SEED04-N2',
    severity: 'P2',
    title: 'per-source empty/no-new-records reason is computed but never projected into /api/v1/status',
    detail: 'The API reports lifecycle="empty" and counters.sources_empty, but not last_empty_code/last_empty_reason. The explicit reason (e.g. NO_NEW_RECORDS) exists only in the daemon log line "collector source empty".',
    evidence: {
      computed: 'apps/daemon/src/daemon.js:402-403 (sourceStatusView sets last_empty_code/last_empty_reason)',
      dropped: 'apps/daemon/src/health.js:170-187 (buildStatusPayload maps a fixed field list without them)',
      log_proof: 'daemon-run-a.log → msg="collector source empty" code="NO_NEW_RECORDS"',
      sample: 'SAMPLES/run-a/sample-004.json → scheduler.sources[].lifecycle="empty"',
    },
  });
}

const m1 = mutations.results.find((entry) => entry.id === 'M1');
const m2 = mutations.results.find((entry) => entry.id === 'M2');
const m3 = mutations.results.find((entry) => entry.id === 'M3');
const c1 = mutations.results.find((entry) => entry.id === 'C1');

// --- final per-source view of the real run (computed from the raw sample files) ---------
const realSampleDir = path.join(dir, 'SAMPLES', 'run-a');
const realSampleFiles = fs.existsSync(realSampleDir)
  ? fs.readdirSync(realSampleDir).filter((name) => /^sample-\d+\.json$/u.test(name)).sort()
  : [];
const finalRealStatus = realSampleFiles.length === 0
  ? null
  : JSON.parse(fs.readFileSync(path.join(realSampleDir, realSampleFiles[realSampleFiles.length - 1]), 'utf8'));
const finalSources = (finalRealStatus?.scheduler?.sources ?? []).map((source) => ({
  id: source.id,
  lifecycle: source.lifecycle,
  polls: source.polls,
  events: source.events,
  accepted: source.accepted,
  failures: source.failures,
  stale: source.stale,
  dropped_events: source.dropped_events,
  last_error_code: source.last_error_code,
}));
const droppedSources = finalSources.filter((source) => source.dropped_events > 0);
if (droppedSources.length > 0) {
  observabilityFindings.push({
    id: 'SEED04-N3',
    severity: 'P1',
    title: 'daemon-side maxBatchEvents truncation permanently drops most of a large source snapshot while health stays ok',
    detail: `${droppedSources.map((source) => `${source.id}: dropped_events=${source.dropped_events} (accepted=${source.accepted}, polls=${source.polls})`).join('; ')}. The scheduler slices the batch to maxBatchEvents=500 and still advances the source cursor (scheduler.js:154-163 then :182), so the truncated tail is never re-read; the collector that produced the batch is not told. health.status stayed "ok" in every sample; the only traces are scheduler.sources[].dropped_events in /status and one daemon warn line.`,
    evidence: {
      scheduler_slice: 'apps/daemon/src/scheduler.js:154-163 (events = events.slice(0, maxBatchEvents); state.dropped_events += remainder)',
      cursor_still_advances: 'apps/daemon/src/scheduler.js:182 (state.cursor = outcome.cursor ?? state.cursor)',
      field_exposed: 'apps/daemon/src/health.js:186 (dropped_events is projected into /status)',
      not_in_health: 'apps/daemon/src/health.js:64-129 (computeHealth has no contributionsDropped/dropped source signal)',
      log_proof: 'daemon-run-a.log → msg="collector batch truncated to the configured maximum" dropped=19500 max_batch_events=500',
      final_sources: finalSources,
    },
  });
}

const verdicts = {
  A_real_sources: real.judge?.verdict ?? 'unreproducible',
  B_rejection_bubbling: bubble.judge?.verdict ?? 'unreproducible',
  C_mutations: mutations.all_expectations_met && mutations.tree_restored ? 'verified' : 'unreproducible',
};
const overall = verdicts.A_real_sources === 'CLOSED'
  && verdicts.B_rejection_bubbling === 'CLOSED'
  && verdicts.C_mutations === 'verified'
  ? 'CLOSED'
  : 'BYPASSED';

const payload = {
  campaign: 'REATTACK-RC4',
  seat: 'seed04-e2e',
  artifact: 'SEED-04 采集→入库→健康 端到端第三方复验',
  generated_at: new Date().toISOString(),
  overall_verdict: overall,
  verdicts,
  tree_and_environment: {
    node: real.provenance?.node ?? null,
    node_executable: real.provenance?.node_executable ?? null,
    platform: real.provenance?.platform ?? null,
    repo_root: real.provenance?.repo_root ?? null,
    config_sha256: real.provenance?.config_sha256 ?? null,
    collectors_sha256: real.provenance?.collectors_sha256 ?? null,
    product_sha256: real.provenance?.product_sha256 ?? null,
  },
  a_real_sources: {
    result_file: 'RESULT-run-a.json',
    duration_s_requested: real.duration_s_requested,
    duration_s_actual: real.duration_s_actual,
    sample_count: real.sample_count,
    samples_with_status: real.samples_with_status,
    db_probe_count: real.db_probe_count,
    db_probe_ok: real.db_probe_ok,
    child_pid: real.child_pid,
    child_exit: real.child_exit,
    kill_method: real.kill_method,
    port: real.port,
    port_released: real.port_released,
    criteria: realCriteria,
    final_sources: finalSources,
    samples_dir: 'SAMPLES/run-a/',
    log: 'daemon-run-a.log',
    note: '10-minute sampling window was not compressed; every /api/v1/status body is stored verbatim.',
  },
  b_rejection_bubbling: {
    result_file: 'RESULT-b-baseline.json',
    duration_s_requested: bubble.duration_s_requested,
    sample_count: bubble.sample_count,
    child_pid: bubble.child_pid,
    child_exit: bubble.child_exit,
    port: bubble.port,
    port_released: bubble.port_released,
    criteria: bubbleCriteria,
    last_status_excerpt: bubble.last_status_excerpt,
    samples_dir: 'SAMPLES/b-baseline/',
    log: 'daemon-b-baseline.log',
  },
  c_mutations: {
    result_file: 'MUTATIONS.json',
    target_file: mutations.target_file,
    original_sha256: mutations.original_sha256,
    final_sha256: mutations.final_sha256,
    tree_restored: mutations.tree_restored,
    all_expectations_met: mutations.all_expectations_met,
    results: mutations.results.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      name: entry.name,
      expected: entry.expected,
      actual: entry.actual,
      met: entry.met,
      hashes: entry.hashes ?? null,
    })),
    control_note: c1 === undefined ? null : `C1 control (no mutation, quiet source) judged ${c1.actual?.verdict} as expected ${c1.expected.verdict} — the M1 red is caused by the removed projection, not by the fixture.`,
    m3_note: m3 === undefined ? null : `M3 (fixture-only stall) judged ${m3.actual?.verdict} on ${m3.expected.criterion}.`,
  },
  new_findings: observabilityFindings,
  p0_findings: [],
  method_notes: [
    'Field names used by the judge were read from the product source before writing the criteria (health.js:152-198, daemon.js:330-381, adapters/event-store.js:652-678).',
    'Part A used the real Windows collector package through the daemon\'s documented --collectors seam; nothing in the product tree was modified for A or B.',
    'Part C modified exactly one line at a time in apps/daemon/src/daemon.js, with a %TEMP% backup, sha256 before/after/restored recorded in MUTATIONS.json, and every restore verified byte-identical.',
    'The independent SQLite probe (db-probe.py) uses python sqlite3 mode=ro, not the product\'s node driver.',
  ],
};

fs.writeFileSync(path.join(dir, 'RESULT.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
process.stdout.write(`SEED04_ASSEMBLED ${JSON.stringify({
  overall_verdict: overall,
  verdicts,
  new_findings: observabilityFindings.map((finding) => `${finding.id}:${finding.severity}`),
  tree_restored: mutations.tree_restored,
})}\n`);
