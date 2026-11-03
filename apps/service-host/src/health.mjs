/**
 * health.mjs — loopback readiness probe used by the host and by the supervisor's tests.
 *
 * The readiness question is not "is the port open" but "is this *our* daemon, serving,
 * and is the token we handed the operator one it will accept". So the probe asks two
 * things, in order:
 *
 * 1. `GET /healthz` — unauthenticated liveness. A 200 means the API is up and the
 *    health aggregate is not `failed`.
 * 2. `GET /api/v1/status` with `Authorization: Bearer <token from file>` — a 200 means
 *    the token file on disk is the one the daemon actually holds. A daemon that
 *    provisioned a different token rejects every request and then trips the auth
 *    lockout, which looks like an outage instead of a provisioning bug.
 *
 * The `Host` header is set explicitly: the API validates it against a literal loopback
 * address plus port, so a probe sent to `127.0.0.1` with the wrong port in `Host` is
 * correctly refused and would be misread as unhealthy.
 */

export const PROBE_PATHS = Object.freeze({ liveness: '/healthz', status: '/api/v1/status' });

/**
 * @param {{ port: number, token: string|null, fetchImpl?: Function, timeoutMs?: number }} input
 * @returns {Promise<{ok: boolean, reason: string, stage: 'liveness'|'auth'|'done'}>}
 */
export async function probeDaemon({ port, token, fetchImpl = globalThis.fetch, timeoutMs = 2000 }) {
  if (typeof fetchImpl !== 'function') {
    return { ok: false, reason: '当前运行时没有 fetch', stage: 'liveness' };
  }
  const base = `http://127.0.0.1:${port}`;
  const headers = { host: `127.0.0.1:${port}` };

  let liveness;
  try {
    liveness = await fetchImpl(`${base}${PROBE_PATHS.liveness}`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { ok: false, reason: `liveness 请求失败：${error.message}`, stage: 'liveness' };
  }
  if (liveness.status !== 200) {
    return { ok: false, reason: `liveness HTTP ${liveness.status}`, stage: 'liveness' };
  }
  if (token === null) {
    return { ok: false, reason: '缺少 api-token 文件', stage: 'auth' };
  }

  let status;
  try {
    status = await fetchImpl(`${base}${PROBE_PATHS.status}`, {
      headers: { ...headers, authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { ok: false, reason: `status 请求失败：${error.message}`, stage: 'auth' };
  }
  if (status.status !== 200) {
    return { ok: false, reason: `status HTTP ${status.status}（token 可能不匹配）`, stage: 'auth' };
  }
  return { ok: true, reason: 'ok', stage: 'done' };
}

/**
 * Poll until the probe succeeds or the deadline passes.
 *
 * @param {{ port: number, token: string|null, deadlineMs?: number, intervalMs?: number, fetchImpl?: Function }} input
 */
export async function waitForHealth({ port, token, deadlineMs = 10_000, intervalMs = 250, fetchImpl = globalThis.fetch }) {
  const deadline = Date.now() + deadlineMs;
  let last = { ok: false, reason: '未开始', stage: 'liveness' };
  while (Date.now() < deadline) {
    last = await probeDaemon({ port, token, fetchImpl });
    if (last.ok) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return { ...last, reason: `${deadlineMs} ms 内未就绪：${last.reason}` };
}
