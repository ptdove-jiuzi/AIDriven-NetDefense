/**
 * ops.mjs — every privileged action the installer performs, behind one interface.
 *
 * Two backends, chosen by mode:
 *
 * - **disarm** — records the action as a JSON line in `install\plan\actions.jsonl`
 *   and returns `{ simulated: true }`. Nothing is executed. This is the backend the
 *   test suite uses, which is why the suite can assert "we would have created this
 *   service with these exact arguments" without creating one.
 * - **armed** — executes it (`reg.exe`, the service host's own `--install-service`,
 *   PowerShell for the `.lnk`, `icacls`). Armed mode requires elevation, which the
 *   caller has already checked; every spawn failure becomes an `OpsError` so the
 *   state machine can decide between rollback and a specific exit code.
 *
 * Why the service is installed by the host binary and not by `sc.exe`: a virtual
 * service account has no password, so `sc create obj=` cannot express it, and
 * `SERVICE_CONFIG_PRESHUTDOWN_INFO` has no `sc.exe` switch at all (ADR §3.2,
 * `release/windows-install.md` §3). Service **creation and deletion** therefore always go
 * through the host binary; **start/stop** use `sc.exe`, which is fine because neither
 * needs a password or a preshutdown timeout. `sc.exe` is never used to create a service —
 * not even as a fallback, because a fallback that silently produces a LocalSystem service
 * would violate D4 while looking successful.
 *
 * Every operation an install/rollback has to be able to undo has an inverse here:
 * `serviceInstall`/`serviceDelete`, `registrySet`/`registryDeleteKey`,
 * `shortcutCreate`/`shortcutDelete`, `eventLogReadersAdd`/`eventLogReadersRemove`.
 * Rollback (H3) is only honest if the inverse exists.
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { EVENT_LOG_READERS_SID, SERVICE_NAME } from './paths.mjs';

export class OpsError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'OpsError';
    this.code = code;
    this.details = details;
  }
}

/** Synchronous sleep without spawning a helper process for it. */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** SIDs, not localized group names: `Event Log Readers` does not exist in zh-CN. */
const SID = Object.freeze({
  administrators: 'S-1-5-32-544',
  system: 'S-1-5-18',
  users: 'S-1-5-32-545',
  eventLogReaders: EVENT_LOG_READERS_SID,
});

/**
 * Windows' "service does not exist" code, and the localized/English texts it can arrive as.
 *
 * `aegis-svc.exe --uninstall-service` returns 1060 when the service is already gone. Treating
 * that as a failure made `/uninstall` unusable after a half-finished uninstall (H5): the
 * phase stayed at `UNINSTALLING`, `/install` refused with 15, and no command could converge.
 * "Already absent" is the desired end state of a delete, so it is success.
 */
export function isServiceAbsentText(text) {
  return /1060|specified service does not exist|service does not exist|服务不存在|指定的服务未安装|没有该服务/iu.test(String(text ?? ''));
}

export function isServiceAbsentError(error) {
  if (error === null || typeof error !== 'object') return false;
  if (error.details?.status === 1060) return true;
  const text = `${error.message ?? ''} ${error.details?.stderr ?? ''} ${error.details?.stdout ?? ''}`;
  return isServiceAbsentText(text);
}

/**
 * The deferred program-tree removal command (README "延迟删除").
 *
 * `&&`, not `&`: `cmd` treats `&` as unconditional sequencing, so a `rmdir` that failed
 * (file locked by the still-running engine, permissions) would still delete
 * `pending-removal.json` — the *only* record that the program tree still has to disappear.
 * That turns an unfinished uninstall into an invisible one (H6). With `&&` the marker
 * survives exactly when the removal failed, which is what `/verify` and `/uninstall` read.
 */
export function deferredRemovalCommand({ target, pendingPath }) {
  return `ping -n 3 127.0.0.1 >nul && rmdir /s /q "${target}" && del /f /q "${pendingPath}"`;
}

/**
 * PowerShell that makes `S-1-5-32-573` membership true (or false), idempotently.
 *
 * Why this exists at all (H4): the install plan used to pass `--event-log-readers` to
 * `aegis-svc.exe`, which **does not parse it** — the flag was recorded, asserted in a test,
 * and never implemented, so the service account was never a member and reading the Security
 * log was always denied. The membership is now an installer action with a real inverse,
 * addressed by SID (the group is localized, the SID is not) and guarded by a membership
 * probe so a repeat run is a no-op instead of an error.
 */
export function eventLogReadersScript({ sid = EVENT_LOG_READERS_SID, account, action }) {
  if (account === undefined || account === null || account === '') {
    throw new OpsError('E_OPS_ARG', 'eventLogReadersScript 需要 account');
  }
  if (action !== 'add' && action !== 'remove') {
    throw new OpsError('E_OPS_ARG', `eventLogReadersScript 不支持的动作：${String(action)}`);
  }
  // Parameter sets, not string shaping: `Add-LocalGroupMember`/`Remove-LocalGroupMember` only
  // gained a `-SID` parameter set in recent Windows builds, so the portable path is
  // "resolve the group by SID, then pass the group object". `Get-LocalGroup -SID` has existed
  // since the LocalAccounts module was introduced (Server 2016 / Windows 10).
  const statements = [
    '$ErrorActionPreference = "Stop"',
    `$sid = '${sid}'`,
    `$acct = '${account.replace(/'/gu, "''")}'`,
    '$group = Get-LocalGroup -SID $sid -ErrorAction Stop',
    // Resolvable only while the service exists. A resumed uninstall runs after the service is
    // gone, and that is not an error: the membership cannot exist without the account, so the
    // probe below simply finds nothing and the operation becomes a no-op.
    '$acctSid = $null',
    'try { $acctSid = (New-Object System.Security.Principal.NTAccount($acct)).Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { $acctSid = $null }',
    '$members = @()',
    'try { $members = @(Get-LocalGroupMember -Group $group -ErrorAction Stop) } catch { $members = @() }',
    '$present = @($members | Where-Object { $_.Name -ieq $acct -or ($null -ne $acctSid -and $_.SID.Value -eq $acctSid) }).Count -gt 0',
  ];
  if (action === 'add') {
    statements.push('if (-not $present) { Add-LocalGroupMember -Group $group -Member $acct -ErrorAction Stop }');
  } else {
    // No `-not` here: removal is guarded by the positive membership test, so an account that
    // is already gone (or never a member) is a success rather than a 30 that blocks /uninstall.
    statements.push('if ($present) { Remove-LocalGroupMember -Group $group -Member $acct -ErrorAction Stop }');
  }
  return statements.join('; ');
}


/**
 * ACL table from `release/windows-install.md` §2.1.
 *
 * `protected: true` means "stop inheriting and keep only these ACEs" — used for
 * `data\secrets\`, where inherited `Users:RX` would otherwise leak the API token.
 */
export function aclPlan(layout) {
  return [
    { key: 'programRoot', path: layout.programRoot, protected: false, grants: [[SID.administrators, 'F'], [SID.system, 'F'], [SID.users, 'RX']] },
    { key: 'appRoot', path: layout.appRoot, protected: false, readOnly: true, grants: [[SID.administrators, 'F'], [SID.system, 'F'], [SID.users, 'RX']] },
    { key: 'dataRoot', path: layout.dataRoot, protected: false, grants: [[SID.administrators, 'F'], [SID.system, 'F'], [SID.users, 'RX']] },
    { key: 'configDir', path: layout.configDir, protected: false, grants: [[SID.administrators, 'F'], [SID.system, 'F'], [SID.users, 'R']] },
    { key: 'dataDir', path: layout.dataDir, protected: false, grants: [[SID.administrators, 'F'], [`NT SERVICE\\${SERVICE_NAME}`, 'F']] },
    { key: 'secretsDir', path: layout.secretsDir, protected: true, grants: [[SID.administrators, 'F'], [`NT SERVICE\\${SERVICE_NAME}`, 'F']] },
    { key: 'installDir', path: layout.installDir, protected: false, grants: [[SID.administrators, 'F'], [SID.system, 'F']] },
  ];
}

/**
 * Is this process elevated? Checked by SID, never by trying to write somewhere and
 * seeing whether it fails — a probe write in `%ProgramFiles%` is itself a side effect.
 */
export function isElevated(env = process.env) {
  if (process.platform !== 'win32') return false;
  const result = spawnSync('whoami', ['/groups'], { encoding: 'utf8', windowsHide: true, env });
  if (result.status !== 0 || typeof result.stdout !== 'string') return false;
  // S-1-16-12288 = High mandatory level, S-1-16-16384 = System.
  return result.stdout.includes('S-1-16-12288') || result.stdout.includes('S-1-16-16384');
}

/**
 * @param {{ mode: 'armed'|'disarm', layout: object, logger: object }} input
 */
export function createOps({ mode, layout, logger }) {
  let seq = 0;

  const record = (action) => {
    seq += 1;
    const entry = { seq, at: new Date().toISOString(), mode, ...action };
    mkdirSync(dirname(layout.planPath), { recursive: true });
    appendFileSync(layout.planPath, `${JSON.stringify(entry)}\n`, 'utf8');
    logger.debug('plan', action.op);
    return { simulated: true, entry };
  };

  const run = (command, args, { code = 'E_OPS_SPAWN' } = {}) => {
    const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
    if (result.error !== undefined) {
      throw new OpsError(code, `无法执行 ${command}：${result.error.message}`, { command, args });
    }
    if (result.status !== 0) {
      throw new OpsError(code, `${command} 退出码 ${result.status}：${(result.stderr ?? '').trim().slice(0, 400)}`, {
        command, args, status: result.status,
      });
    }
    return result;
  };

  const ops = {
    mode,
    /** Number of actions recorded so far (disarm only). */
    get recorded() {
      return seq;
    },

    registrySet(key, name, type, value) {
      if (mode === 'disarm') return record({ op: 'registry.set', key, name, type, value });
      const typeFlag = { REG_SZ: '/t REG_SZ', REG_DWORD: '/t REG_DWORD', REG_EXPAND_SZ: '/t REG_EXPAND_SZ' }[type];
      if (typeFlag === undefined) throw new OpsError('E_OPS_ARG', `不支持的注册表类型：${type}`);
      return { simulated: false, result: run('reg', ['add', key, '/v', name, ...typeFlag.split(' '), '/d', String(value), '/f']) };
    },

    registryDeleteKey(key) {
      if (mode === 'disarm') return record({ op: 'registry.delete-key', key });
      const result = spawnSync('reg', ['delete', key, '/f'], { encoding: 'utf8', windowsHide: true });
      // Deleting a key that is not there is success: uninstall must be idempotent.
      if (result.status !== 0 && !/unable to find|找不到/u.test(`${result.stdout}${result.stderr}`)) {
        throw new OpsError('E_OPS_REGISTRY', `reg delete ${key} 失败：${(result.stderr ?? '').trim()}`, { key });
      }
      return { simulated: false, result };
    },

    /**
     * Register the service through the host binary.
     *
     * The host owns `CreateService` + `ChangeServiceConfig2(SERVICE_CONFIG_SERVICE_SID_INFO)`
     * because it is the only component that can express a virtual service account and a
     * PRESHUTDOWN timeout. When the binary is missing we refuse — we do not approximate
     * it with `sc.exe`.
     */
    serviceInstall(spec) {
      const argv = [
        '--install-service',
        '--app', layout.appRoot,
        '--node', layout.nodeExe,
        '--config', layout.configPath,
        '--account', `NT SERVICE\\${SERVICE_NAME}`,
        '--start', 'delayed-auto',
        '--preshutdown-ms', '120000',
      ];
      if (mode === 'disarm') return record({ op: 'service.install', exe: layout.serviceHostExe, argv, ...spec });
      return { simulated: false, result: run(layout.serviceHostExe, argv, { code: 'E_SERVICE_INSTALL' }) };
    },

    serviceStart() {
      if (mode === 'disarm') return record({ op: 'service.start', name: SERVICE_NAME });
      return { simulated: false, result: run('sc', ['start', SERVICE_NAME], { code: 'E_SERVICE_START' }) };
    },

    serviceStop({ timeoutMs = 90_000 } = {}) {
      if (mode === 'disarm') return record({ op: 'service.stop', name: SERVICE_NAME, timeoutMs });
      // `sc stop` returns immediately; the wait is what actually proves it stopped.
      const stop = spawnSync('sc', ['stop', SERVICE_NAME], { encoding: 'utf8', windowsHide: true });
      const stopText = `${stop.stdout ?? ''}${stop.stderr ?? ''}`;
      if (stop.status !== 0) {
        // H5, the other entrance: a service that is already gone has nothing to stop. This
        // used to be exit 20 with the phase parked at `UNINSTALLING`, which deadlocked both
        // `/uninstall` (rerun answered 20 forever) and `/install` (answered 15) — the same
        // lock as the delete path, reached through `sc stop` instead of `--uninstall-service`.
        // The numeric status is authoritative: `sc.exe` reports the Win32 error as its exit
        // code, and its message is localized/OEM-encoded (Node decodes it as UTF-8, so the
        // text below is a best-effort fallback, not the primary test).
        if (stop.status === 1060 || isServiceAbsentText(stopText)) return { simulated: false, stopped: true, absent: true };
        if (!/not active|未启动|1062/u.test(stopText)) {
          throw new OpsError('E_SERVICE_STOP', `sc stop 失败：${(stop.stderr ?? '').trim()}`, {});
        }
      }
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const query = spawnSync('sc', ['query', SERVICE_NAME], { encoding: 'utf8', windowsHide: true });
        const output = `${query.stdout ?? ''}${query.stderr ?? ''}`;
        if (/STOPPED/u.test(output)) return { simulated: false, stopped: true };
        // Deleted while we waited: "stopped" is the truth we were waiting for.
        if (isServiceAbsentText(output)) return { simulated: false, stopped: true, absent: true };
        sleep(150);
      }
      throw new OpsError('E_SERVICE_STOP', `服务 ${SERVICE_NAME} 在 ${timeoutMs} ms 内未停止`, {});
    },

    serviceDelete() {
      const argv = ['--uninstall-service'];
      if (mode === 'disarm') return record({ op: 'service.delete', exe: layout.serviceHostExe, argv });
      try {
        return { simulated: false, result: run(layout.serviceHostExe, argv, { code: 'E_SERVICE_DELETE' }) };
      } catch (error) {
        // H5: the host returns 1060 when the service is already gone. A delete whose target
        // is absent has succeeded; reporting failure here deadlocks the uninstall.
        if (isServiceAbsentError(error)) return { simulated: false, absent: true };
        throw error;
      }
    },

    /**
     * Make/removes the service account's membership of `S-1-5-32-573` (ADR D14).
     *
     * The membership must exist before the service starts reading the Security log, and must
     * be removed on uninstall — so both directions are here, not just the create side.
     */
    eventLogReadersAdd({ account = `NT SERVICE\\${SERVICE_NAME}`, sid = EVENT_LOG_READERS_SID } = {}) {
      if (mode === 'disarm') return record({ op: 'eventlog.readers.add', sid, account });
      return {
        simulated: false,
        result: run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-Command', eventLogReadersScript({ sid, account, action: 'add' })], { code: 'E_EVENTLOG_READERS' }),
      };
    },

    eventLogReadersRemove({ account = `NT SERVICE\\${SERVICE_NAME}`, sid = EVENT_LOG_READERS_SID } = {}) {
      if (mode === 'disarm') return record({ op: 'eventlog.readers.remove', sid, account });
      return {
        simulated: false,
        result: run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-Command', eventLogReadersScript({ sid, account, action: 'remove' })], { code: 'E_EVENTLOG_READERS' }),
      };
    },

    shortcutCreate({ lnk, target, args, workingDirectory, description }) {
      if (mode === 'disarm') {
        return record({ op: 'shortcut.create', lnk, target, args, workingDirectory, description });
      }
      const script = [
        '$ErrorActionPreference = "Stop"',
        '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:AIDND_LNK)',
        '$s.TargetPath = $env:AIDND_TARGET',
        '$s.Arguments = $env:AIDND_ARGS',
        '$s.WorkingDirectory = $env:AIDND_WD',
        '$s.Description = $env:AIDND_DESC',
        '$s.Save()',
      ].join('; ');
      return {
        simulated: false,
        result: run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
          code: 'E_SHORTCUT',
        }),
      };
    },

    /** Inverse of `shortcutCreate`, needed for "as if never installed" (H3). */
    shortcutDelete({ lnk }) {
      if (mode === 'disarm') return record({ op: 'shortcut.delete', lnk });
      const script = '$ErrorActionPreference = "SilentlyContinue"; Remove-Item -LiteralPath $env:AIDND_LNK -Force';
      return {
        simulated: false,
        result: run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
          code: 'E_SHORTCUT',
        }),
      };
    },

    acl(entry) {
      // SIDs are passed with the `*` prefix so the lookup never goes through a
      // localized group name; account names (the virtual service account) are quoted.
      const grants = entry.grants.map(([who, rights]) => (who.startsWith('S-')
        ? `*${who}:(OI)(CI)${rights}`
        : `"${who}":(OI)(CI)${rights}`));
      if (mode === 'disarm') {
        return record({ op: 'acl.apply', path: entry.path, protected: entry.protected === true, grants });
      }
      const args = [entry.path];
      if (entry.protected === true) args.push('/inheritance:r');
      args.push('/grant:r', ...grants);
      return { simulated: false, result: run('icacls', args, { code: 'E_ACL' }) };
    },

    /**
     * Delete the program tree after this process exits.
     *
     * The engine may itself be running from a path inside the program tree, and a
     * running `node.exe` cannot be deleted. Rather than pretend, the removal is handed
     * to a detached `cmd` that waits ~2 s for us to exit (§ README "延迟删除").
     */
    scheduleProgramTreeRemoval({ target, pendingPath }) {
      const command = deferredRemovalCommand({ target, pendingPath });
      if (mode === 'disarm') {
        return record({ op: 'fs.deferred-removal', target, pendingPath, command: `cmd.exe /c ${command}` });
      }
      const child = spawnSync('cmd.exe', ['/c', 'start', '/b', 'cmd.exe', '/c', command], {
        windowsHide: true, stdio: 'ignore', detached: true,
      });
      return { simulated: false, result: child };
    },
  };

  return ops;
}
