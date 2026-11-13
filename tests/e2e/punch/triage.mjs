/**
 * triage.mjs — 汇总 PUNCH 跑批数据，产出候选缺陷（供人工定级）
 * 作者：PT-dove
 *
 * 用法：node tests/e2e/punch/triage.mjs
 * 输入：docs/implementation/evidence/ui2/punch/run-log.{data,empty,groups,scenarios}.json
 * 输出：docs/implementation/evidence/ui2/punch/candidates.json
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const EVID = join(REPO, 'docs', 'implementation', 'evidence', 'ui2', 'punch');

const FILES = ['run-log.data.json', 'run-log.empty.json', 'run-log.groups.json', 'run-log.scenarios.json'];

function loadAll() {
  const logs = [];
  for (const f of FILES) {
    const p = join(EVID, f);
    if (!existsSync(p)) continue;
    try {
      logs.push({ file: f, log: JSON.parse(readFileSync(p, 'utf8')) });
    } catch (error) {
      console.error('读取失败 ' + f + ': ' + error.message);
    }
  }
  return logs;
}

/** 稳定签名：去掉会波动的数值/时间戳，只留结构与文案骨架。 */
function sigOf(rec) {
  const item = rec.item || {};
  const text = String(item.text || '').replace(/\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?\s*\d{1,2}:\d{2}(:\d{2})?/g, '<time>')
    .replace(/\b\d{2,}\b/g, '<n>').slice(0, 40);
  return [item.tag, item.role || '', item.type || '', item.tab || '', text, item.path || ''].join('|');
}

function groupStates(logs) {
  const byKey = new Map();
  for (const { file, log } of logs) {
    for (const st of log.states || []) {
      const prev = byKey.get(st.key);
      if (!prev || String(st.finishedAt || '') > String(prev.finishedAt || '')) byKey.set(st.key, { ...st, _file: file });
    }
  }
  return [...byKey.values()];
}

function scenarioList(logs) {
  const byKey = new Map();
  for (const { file, log } of logs) {
    for (const sc of log.scenarios || []) {
      const key = [sc.id, sc.stack, sc.buildHash].join('|');
      byKey.set(key, { ...sc, _file: file });
    }
  }
  return [...byKey.values()];
}

const logs = loadAll();
if (!logs.length) {
  console.error('没有可汇总的 run-log 文件');
  process.exit(1);
}
const states = groupStates(logs);
const scenarios = scenarioList(logs);

const builds = new Map();
for (const { file, log } of logs) {
  for (const b of log.batches || []) {
    builds.set(b.buildHash, { file, files: b.buildFiles, newestMtime: b.buildNewestMtime, mode: b.mode, startedAt: b.startedAt });
  }
}

const stats = {
  states: states.length,
  clicks: { total: 0, ok: 0, error: 0, no_effect: 0, skipped: 0, skipped_disabled: 0 },
  byStack: {}, byRoute: {}, byCategory: {},
};
for (const st of states) {
  const t = st.totals || {};
  for (const k of Object.keys(stats.clicks)) stats.clicks[k] += t[k] || 0;
  stats.byStack[st.stack] = stats.byStack[st.stack] || { states: 0, clicks: 0, error: 0, no_effect: 0 };
  stats.byStack[st.stack].states += 1;
  stats.byStack[st.stack].clicks += t.total || 0;
  stats.byStack[st.stack].error += t.error || 0;
  stats.byStack[st.stack].no_effect += t.no_effect || 0;
  const rk = st.route;
  stats.byRoute[rk] = stats.byRoute[rk] || { states: 0, clicks: 0, error: 0, no_effect: 0 };
  stats.byRoute[rk].states += 1;
  stats.byRoute[rk].clicks += t.total || 0;
  stats.byRoute[rk].error += t.error || 0;
  stats.byRoute[rk].no_effect += t.no_effect || 0;
}

const candidates = new Map();
for (const st of states) {
  for (const rec of st.clicks || []) {
    if (rec.kind === 'skip') continue;
    const cat = rec.category;
    if (cat !== 'error' && cat !== 'no_effect') continue;
    const sig = cat + '||' + sigOf(rec) + '||' + (cat === 'error' ? JSON.stringify((rec.reasons || []).slice(0, 2)).slice(0, 120) : '');
    const entry = candidates.get(sig) || {
      key: sig,
      category: cat,
      item: rec.item,
      reasons: rec.reasons,
      errorKind: rec.errorKind || null,
      envs: [],
      sample: rec,
      count: 0,
    };
    entry.count += 1;
    entry.envs.push({ stack: st.stack, route: st.route, theme: st.theme, lang: st.lang, group: st.group || null, buildHash: st.buildHash, shot: rec.shot || null });
    // 保留证据最完整的一条
    if ((rec.mutations && rec.mutations.n) >= (entry.sample.mutations && entry.sample.mutations.n || 0)) entry.sample = rec;
    candidates.set(sig, entry);
  }
}

const list = [...candidates.values()]
  .map((c) => ({
    ...c,
    envs: c.envs.slice(0, 8),
    envCount: c.envs.length,
    stacks: [...new Set(c.envs.map((e) => e.stack))],
    routes: [...new Set(c.envs.map((e) => e.route))],
    themes: [...new Set(c.envs.map((e) => e.theme))],
    langs: [...new Set(c.envs.map((e) => e.lang))],
    sample: {
      action: c.sample.action,
      before: c.sample.before,
      post: c.sample.post,
      targetBefore: c.sample.targetBefore,
      targetAfter: c.sample.targetAfter,
      occurrences: c.sample.mutations,
      deltas: c.sample.deltas,
      errorSignals: c.sample.errorSignals,
      overlayOpened: c.sample.overlayOpened,
      reasons: c.sample.reasons,
      shot: c.sample.shot || null,
    },
  }))
  .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

const out = {
  generatedAt: new Date().toISOString(),
  builds: [...builds.entries()].map(([hash, b]) => ({ buildHash: hash, ...b })),
  stats,
  scenarios: scenarios.map((s) => ({ id: s.id, name: s.name, stack: s.stack, outcome: s.outcome, note: s.note || null, buildHash: s.buildHash, elapsedMs: s.elapsedMs, details: s.details || null, steps: s.steps || [] })),
  candidates: list,
};
writeFileSync(join(EVID, 'candidates.json'), JSON.stringify(out, null, 1), 'utf8');

console.log('states=' + stats.states + ' clicks=' + JSON.stringify(stats.clicks));
console.log('builds=' + JSON.stringify([...builds.keys()].map((h) => h.slice(0, 12))));
console.log('candidates=' + list.length + ' (error=' + list.filter((c) => c.category === 'error').length + ', no_effect=' + list.filter((c) => c.category === 'no_effect').length + ')');
for (const c of list.slice(0, 40)) {
  const it = c.item || {};
  console.log([c.category, c.count + 'x', c.stacks.join(','), c.routes.join(','), c.themes.join(','), c.langs.join(','), it.tag, (it.text || '').slice(0, 30), '|', (it.path || '').slice(-60), '|', (c.reasons && c.reasons[0] || '').slice(0, 80)].join(' '));
}
console.log('scenarios:');
for (const s of out.scenarios) console.log([s.id, s.stack, s.outcome, s.note || '', s.buildHash.slice(0, 12)].join(' '));
console.log('-> ' + join(EVID, 'candidates.json'));
