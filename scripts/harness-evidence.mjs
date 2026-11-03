import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { release, tmpdir, type } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, sha256File } from '@aegisharness/harness-adapter';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = join(root, 'tests', 'wp0', 'evidence');
const commands = process.argv.slice(2).filter((argument) => argument.startsWith('--command='));
const results = commands.map((argument) => {
  const [name, code] = argument.slice('--command='.length).split('=');
  return { name, exitCode: Number(code) };
});
const npmVersion = execFileSync('npm', ['--version'], {
  encoding: 'utf8',
  shell: process.platform === 'win32',
}).trim();
const environment = {
  schemaVersion: '1.0',
  author: 'PT-dove',
  node: process.version,
  npm: npmVersion,
  executable: process.execPath,
  platform: process.platform,
  arch: process.arch,
  os: `${type()} ${release()}`,
  temporaryRoot: tmpdir(),
  repositoryRoot: root,
  upstream: readJson(join(evidence, 'harness-input-summary.json')).upstream,
};
writeFileSync(join(evidence, 'harness-environment.json'), `${JSON.stringify(environment, null, 2)}\n`);

let testCounts = {};
try {
  const log = readFileSync(join(evidence, 'npm-test-wp0.log'), 'utf8');
  // The spec reporter prints "ℹ tests 30"; the TAP reporter prints "# tests 30".
  const count = (name) => {
    const match = log.match(new RegExp(`^[#ℹ]\\s*${name}\\s+(\\d+)$`, 'm'));
    return match ? Number(match[1]) : undefined;
  };
  testCounts = Object.fromEntries(
    Object.entries({ tests: count('tests'), pass: count('pass'), fail: count('fail') })
      .filter(([, value]) => value !== undefined),
  );
  if (Object.keys(testCounts).length === 0) testCounts = { unreadable: true };
} catch {
  testCounts = { unreadable: true };
}
const validation = readJson(join(evidence, 'harness-validation.json'));
writeFileSync(join(evidence, 'harness-command-summary.json'), `${JSON.stringify({
  schemaVersion: '1.0',
  commands: results,
  testCounts,
  acceptanceStatus: validation.status,
  note: 'Command success proves the implementation and negative controls ran; it does not convert the frozen-contract NO-GO into acceptance.',
  provenance: 'Each exit code is the result of the most recent real run of that command in this repository, as recorded in docs/implementation/status/MASTER.md. Exit codes passed on the command line are never invented here.',
}, null, 2)}\n`);

const hashes = readdirSync(evidence, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name !== 'harness-evidence-sha256.json')
  .map((entry) => entry.name)
  .sort((left, right) => left.localeCompare(right, 'en'))
  .map((name) => ({ file: name, sha256: sha256File(join(evidence, name)) }));
writeFileSync(join(evidence, 'harness-evidence-sha256.json'), `${JSON.stringify({
  schemaVersion: '1.0',
  author: 'PT-dove',
  note: 'Snapshot index taken when this file was generated. It is NOT enforced by any gate, and it goes stale by design: tests/wp0/harness/* rewrites the stdio and four-layer evidence on every run, so a later `npm test` necessarily changes the hashes below and their mtime. Regenerate with `node scripts/harness-evidence.mjs --command=...` after a run; do not treat a mismatch as tampering without checking mtime.',
  files: hashes,
}, null, 2)}\n`);
console.log(`Saved environment, ${results.length} command results, and ${hashes.length} evidence hashes.`);
