/**
 * Async loader hook that rewrites one product module *in memory* as it is loaded.
 * Nothing on disk changes; the sha256 of every product file stays the same.
 *
 *   RT_MUT=m1  packages/collectors/windows/powershell.js  — empty-output guard => `return null`
 *             (pre-fix behaviour: "exit 0, printed nothing" was reported as an empty read)
 *   RT_MUT=m2  apps/service-host/src/sources.mjs         — wiring returns no sources at all
 *   RT_MUT=m3  packages/policy/src/model-routing.js      — evidenceRef existence check disabled
 *
 * Author: PT-dove
 */

const MUT = process.env.RT_MUT;

const RULES = {
  m1: {
    suffix: 'packages/collectors/windows/powershell.js',
    apply(src) {
      const anchor = 'const text = stripBom(stdout).trim();';
      if (!src.includes(anchor)) throw new Error('m1 anchor not found');
      return src.replace(anchor, `${anchor}\n  if (text.length === 0) { return null; } // MUTATION m1`);
    },
  },
  m2: {
    suffix: 'apps/service-host/src/sources.mjs',
    apply(src) {
      const anchor = 'export async function buildSources({';
      if (!src.includes(anchor)) throw new Error('m2 anchor not found');
      return src.replace(
        anchor,
        '// MUTATION m2: wiring removed\nexport async function buildSources() { return { sources: [], reason: null, notes: [], bootId: null }; }\nexport async function buildSourcesUnused({',
      );
    },
  },
  m3: {
    suffix: 'packages/policy/src/model-routing.js',
    apply(src) {
      const anchor =
        "if (signal.evidenceRef === undefined || signal.evidenceRef === null || signal.evidenceRef.trim() === '') {";
      if (!src.includes(anchor)) throw new Error('m3 anchor not found');
      return src.replace(anchor, 'if (false) { // MUTATION m3');
    },
  },
};

const rule = RULES[MUT];
if (!rule) throw new Error(`unknown RT_MUT=${MUT}`);

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!url.includes(rule.suffix)) return result;
  const text = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');
  process.stderr.write(`MUTATION ${MUT} applied to ${url}\n`);
  return { ...result, source: rule.apply(text) };
}
