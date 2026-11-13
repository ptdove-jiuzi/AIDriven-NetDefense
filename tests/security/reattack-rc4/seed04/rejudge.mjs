#!/usr/bin/env node
/**
 * rejudge.mjs — recompute the SEED-04 judgements from the raw artefacts already on disk.
 *
 * The daemon is **not** started: this reads the verbatim `/api/v1/status` bodies from
 * `SAMPLES/<label>/sample-NNN.json` (and the independent `db-probe-NNN.json` for the
 * real-source run), re-runs the pure criteria in judge.mjs and rewrites
 * `RESULT-<label>.json`. This is how a criterion can be tightened without re-running a
 * 10-minute sampling window: the raw evidence never changes, only the judgement on it.
 *
 * With `--mutations` it also refreshes the expected/actual comparison in MUTATIONS.json
 * from the re-judged RESULT files (the recorded sha256 values are kept as-is: they
 * describe what happened on disk during the mutation run).
 *
 * Usage: node rejudge.mjs --outdir <evidence dir> [--mutations]
 */

import fs from 'node:fs';
import path from 'node:path';

import { judgeRealRun, judgeRejectionRun, judgeSourceRun } from './judge.mjs';

const args = { outdir: null, mutations: false };
for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  if (token === '--outdir') {
    args.outdir = process.argv[index + 1];
    index += 1;
  } else if (token === '--mutations') {
    args.mutations = true;
  } else {
    throw new Error(`unknown argument: ${token}`);
  }
}
if (args.outdir === null) {
  throw new Error('--outdir is required');
}
const dir = path.resolve(args.outdir);

/** Labels this campaign produces, with the judge they belong to. */
const LABELS = [
  { label: 'run-a', kind: 'real' },
  { label: 'b-baseline', kind: 'b', suspectIds: ['seed04.reject'] },
  { label: 'c1-control-quiet-honest', kind: 'source' },
  { label: 'm1-empty-projected-ok', kind: 'source' },
  { label: 'm2-rejection-counter-off', kind: 'b', suspectIds: ['seed04.reject'] },
  { label: 'm3-stall-no-growth', kind: 'source' },
];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadSamples(label) {
  const sampleDir = path.join(dir, 'SAMPLES', label);
  if (!fs.existsSync(sampleDir)) {
    return null;
  }
  const files = fs.readdirSync(sampleDir)
    .filter((name) => /^sample-\d+\.json$/u.test(name))
    .sort();
  const samples = [];
  for (const name of files) {
    const index = Number(name.slice('sample-'.length, -'.json'.length));
    const status = readJson(path.join(sampleDir, name));
    const tIso = typeof status.now === 'string' ? status.now : null;
    samples.push({
      index,
      t_iso: tIso,
      t_ms: tIso === null ? null : Date.parse(tIso),
      http_status: 200,
      error: null,
      healthz: null,
      status,
      body_file: name,
    });
  }
  return samples;
}

function loadProbes(label) {
  const sampleDir = path.join(dir, 'SAMPLES', label);
  const files = fs.readdirSync(sampleDir)
    .filter((name) => /^db-probe-\d+\.json$/u.test(name))
    .sort();
  return files.map((name) => {
    const probe = readJson(path.join(sampleDir, name));
    return { ...probe, index: Number(name.slice('db-probe-'.length, -'.json'.length)) };
  });
}

function judgeFor(entry, samples) {
  if (entry.kind === 'real') {
    return judgeRealRun(samples, loadProbes(entry.label));
  }
  if (entry.kind === 'b') {
    const logPath = path.join(dir, `daemon-${entry.label}.log`);
    const logText = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
    return judgeRejectionRun(samples, logText, { suspectIds: entry.suspectIds });
  }
  return judgeSourceRun(samples);
}

const refreshed = [];
for (const entry of LABELS) {
  const samples = loadSamples(entry.label);
  if (samples === null || samples.length === 0) {
    process.stdout.write(`[skip] ${entry.label}: no samples\n`);
    continue;
  }
  const resultPath = path.join(dir, `RESULT-${entry.label}.json`);
  const previous = fs.existsSync(resultPath) ? readJson(resultPath) : {};
  const judge = judgeFor(entry, samples);
  const updated = {
    ...previous,
    judge,
    rejudged_at: new Date().toISOString(),
    rejudge_note: 'judged offline from the verbatim SAMPLES/*.json bodies with judge.mjs (no daemon started)',
  };
  fs.writeFileSync(resultPath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
  refreshed.push({ label: entry.label, verdict: judge.verdict, failed: judge.failed });
  process.stdout.write(`[rejudge] ${entry.label}: ${judge.verdict}${judge.failed.length > 0 ? ` failed=${JSON.stringify(judge.failed)}` : ''}\n`);
}

if (args.mutations) {
  const mutationsPath = path.join(dir, 'MUTATIONS.json');
  const mutations = readJson(mutationsPath);
  for (const entry of mutations.results) {
    const label = entry.run?.label;
    const resultPath = path.join(dir, `RESULT-${label}.json`);
    if (!fs.existsSync(resultPath)) {
      entry.met = false;
      entry.actual = { verdict: null, detail: `missing RESULT for label ${label}` };
      continue;
    }
    const judged = readJson(resultPath);
    const criterion = (judged.judge?.criteria ?? []).find((candidate) => candidate.id === entry.expected.criterion) ?? null;
    entry.actual = criterion === null ? null : { verdict: criterion.verdict, detail: criterion.detail, kind: criterion.kind ?? null };
    entry.met = criterion !== null && criterion.verdict === entry.expected.verdict;
  }
  mutations.all_expectations_met = mutations.results.every((entry) => entry.met && (entry.tree_unchanged !== false));
  mutations.rejudged_at = new Date().toISOString();
  fs.writeFileSync(mutationsPath, `${JSON.stringify(mutations, null, 2)}\n`, 'utf8');
  process.stdout.write(`[rejudge] MUTATIONS.json refreshed: all_expectations_met=${mutations.all_expectations_met} tree_restored=${mutations.tree_restored}\n`);
  for (const entry of mutations.results) {
    process.stdout.write(`          ${entry.id}: expected ${entry.expected.verdict} actual ${entry.actual?.verdict} -> ${entry.met ? 'OK' : 'MISMATCH'}${entry.actual?.detail ? ` (${String(entry.actual.detail).slice(0, 160)})` : ''}\n`);
  }
}

const ok = refreshed.every((entry) => {
  const expected = LABELS.find((candidate) => candidate.label === entry.label);
  return expected !== undefined;
});
process.stdout.write(`SEED04_REJUDGE ${JSON.stringify({ refreshed, ok })}\n`);
process.exitCode = refreshed.length === LABELS.length ? 0 : 1;
