/**
 * The safety boundary around `armed` / `disarm`.
 *
 * The rule being enforced: a run that is not explicitly armed and elevated cannot reach a
 * real system location, and a run that *is* armed cannot be redirected somewhere else. Both
 * directions matter — the first stops a test from registering a service, the second stops
 * an operator from "just pointing it at D:\temp" and calling it an install.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildLayout, rejectDisarmRoot } from '../../deploy/windows/installer/src/paths.mjs';
import { listFiles } from '../../deploy/windows/installer/src/fsx.mjs';
import { main } from '../../deploy/windows/installer/main.mjs';
import { createPayload, tempRoot } from './fixtures/payload.mjs';

const INSTALLER_SOURCE = fileURLToPath(new URL('../../deploy/windows/installer/', import.meta.url));

/** main() writes to stdout; the tests only care about the return code. */
export function silentStdout() {
  return { write() {} };
}

test('no command is a usage error, not an implicit install', async () => {
  assert.equal(await main([], { stdout: silentStdout() }), 10);
});

test('an unknown flag is refused instead of ignored', async () => {
  assert.equal(await main(['/instal'], { stdout: silentStdout() }), 10);
  assert.equal(await main(['/install', '/nonsense'], { stdout: silentStdout() }), 10);
});

test('disarm mode without --root is refused', async () => {
  const code = await main(['/verify', '--mode', 'disarm'], { stdout: silentStdout() });
  assert.equal(code, 10);
});

test('a disarm root inside a real system location is refused', () => {
  // Deliberately outside the temp directory: temp is exempted (see paths.mjs), so a temp
  // path would not exercise this rule at all.
  const env = { ...process.env, ProgramFiles: 'D:\\fake\\PF', ProgramData: 'D:\\fake\\PD' };
  const reasons = rejectDisarmRoot('D:\\fake\\PF\\AIDriven NetDefense', env);
  assert.equal(reasons.length > 0, true);
  assert.match(reasons.join(' '), /真实系统位置/u);
});

test('the temp directory is exempt from the system-location rule, but only temp itself', (t) => {
  const scratch = tempRoot(t);
  assert.deepEqual(rejectDisarmRoot(join(scratch, 'install-root'), process.env), []);

  // A path under a *different* AppData/Local root is not exempt.
  const env = { ...process.env, LOCALAPPDATA: 'D:\\scratch', APPDATA: 'D:\\roaming', USERPROFILE: 'D:\\home' };
  assert.equal(rejectDisarmRoot('D:\\scratch\\install-root', env).length > 0, true);
});

test('a volume root is never an acceptable disarm root', () => {
  const reasons = rejectDisarmRoot('D:\\', process.env);
  assert.match(reasons.join(' '), /卷根|层级过浅/u);
});

test('armed mode refuses --root: the real paths are fixed by the ADR, not by a flag', () => {
  assert.throws(
    () => buildLayout({ mode: 'armed', root: 'D:\\somewhere' }),
    /不接受 --root/u,
  );
});

test('armed mode cannot be requested with a root through the CLI either', async () => {
  const code = await main(['/verify', '--mode', 'armed', '--root', 'D:\\x'], { stdout: silentStdout() });
  // Either the elevation check or the layout check refuses; both are 10 or 11, never 0.
  assert.equal([10, 11].includes(code), true, `unexpected exit ${code}`);
});

test('an armed install on a non-Windows host is refused rather than attempted', async () => {
  if (process.platform === 'win32') {
    // On Windows the equivalent check is elevation, which this session may or may not have.
    const code = await main(['/verify', '--mode', 'armed'], { stdout: silentStdout() });
    assert.equal([0, 10, 11].includes(code), true);
    return;
  }
  assert.equal(await main(['/verify', '--mode', 'armed'], { stdout: silentStdout() }), 10);
});

test('a full disarm install writes only under its --root, and nothing under the real ProgramData', async (t) => {
  const root = tempRoot(t);
  const payload = createPayload(join(root, 'payload'));
  const programDataProduct = join(process.env.ProgramData ?? 'C:\\ProgramData', 'AIDriven NetDefense');
  const programFilesProduct = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'AIDriven NetDefense');
  const existedBefore = {
    programData: existsSync(programDataProduct),
    programFiles: existsSync(programFilesProduct),
  };

  const installRoot = join(root, 'install-root');
  const code = await main([
    '/install', '/S',
    '--mode', 'disarm',
    '--root', installRoot,
    '--payload', payload.root,
    '--version', '0.0.1',
    '--engine-source', INSTALLER_SOURCE,
  ], { stdout: silentStdout() });
  assert.equal(code, 0, 'install should succeed in disarm mode');

  // Every file the run created is under the declared root.
  const created = listFiles(installRoot);
  assert.ok(created.length > 0);
  for (const relativePath of created) {
    const absolute = resolve(installRoot, relativePath);
    assert.equal(absolute.toLowerCase().startsWith(resolve(installRoot).toLowerCase()), true, `escaped the root: ${absolute}`);
  }

  // The real system locations are untouched. If one already existed on this machine, its
  // existence is unchanged — the test never deletes somebody else's install to prove a point.
  assert.equal(existsSync(programDataProduct), existedBefore.programData, 'disarm wrote to the real ProgramData');
  assert.equal(existsSync(programFilesProduct), existedBefore.programFiles, 'disarm wrote to the real Program Files');
});

test('/purge /silent without /confirm is refused (clearing data is irreversible)', async (t) => {
  const root = tempRoot(t);
  const code = await main(
    ['/purge', '/S', '--mode', 'disarm', '--root', join(root, 'install-root')],
    { stdout: silentStdout() },
  );
  assert.equal(code, 10);
});

test('/rollback is refused with 25 and performs nothing', async (t) => {
  const root = tempRoot(t);
  const installRoot = join(root, 'install-root');
  mkdirSync(installRoot, { recursive: true });
  const code = await main(['/rollback', '--mode', 'disarm', '--root', installRoot], { stdout: silentStdout() });
  assert.equal(code, 25);
  assert.deepEqual(listFiles(installRoot), []);
});

test('--root is the only way to redirect a disarm run; the default is to refuse', async () => {
  // Without --root the mode defaults to armed, which on this machine is either elevated
  // (and would refuse the layout) or not elevated (11). Either way it never writes.
  const code = await main(['/verify'], { stdout: silentStdout() });
  assert.equal([10, 11].includes(code), true);
  void tmpdir;
});
