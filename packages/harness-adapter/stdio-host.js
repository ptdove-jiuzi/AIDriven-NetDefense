import { spawn } from 'node:child_process';

export const STDERR_LIMIT = 64 * 1024;

function protocolError(message, details = {}) {
  const error = new Error(message);
  error.code = 'ERR_STDIO_PROTOCOL';
  Object.assign(error, details);
  return error;
}

/**
 * Drive the production newline-delimited JSON-RPC stdio transport without a
 * client SDK or a transport shim. Every stdout line must be a JSON-RPC frame.
 */
export async function runStdioProbe({
  script,
  scriptArgs = ['--profile', 'aegis-analysis'],
  cwd,
  env,
  model = 'deepseek-chat',
  maxTokens = 2000,
  mode = 'shutdown',
  sessionId = 'wp0-analysis',
  promptText = 'Synthetic harmless WP0 model-policy probe',
  timeoutMs = 20000,
}) {
  const child = spawn(process.execPath, [script, ...scriptArgs], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const frames = [];
  const methods = [];
  const pending = new Map();
  let nextId = 1;
  let stdoutBuffer = '';
  let stderr = '';
  let settled = false;
  let failure;

  const exit = new Promise((resolve) => {
    child.once('error', (error) => {
      failure ??= error;
    });
    child.once('exit', (code, signal) => {
      for (const waiter of pending.values()) {
        waiter.reject(protocolError('Worker exited with pending JSON-RPC requests', {
          exitCode: code,
          signal,
          stderr,
          frames,
        }));
      }
      pending.clear();
      resolve({ code, signal });
    });
  });

  function fail(error) {
    failure ??= error instanceof Error ? error : new Error(String(error));
    if (child.exitCode === null && child.signalCode === null) child.kill();
    for (const waiter of pending.values()) waiter.reject(failure);
    pending.clear();
  }

  child.stderr.on('data', (chunk) => {
    if (Buffer.byteLength(stderr) + chunk.length > STDERR_LIMIT) {
      fail(protocolError(`Worker stderr exceeded ${STDERR_LIMIT} bytes`, { frames }));
      return;
    }
    stderr += chunk.toString('utf8');
  });

  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString('utf8');
    while (true) {
      const newline = stdoutBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = stdoutBuffer.slice(0, newline).replace(/\r$/, '');
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line.length === 0) {
        fail(protocolError('Worker emitted a blank stdout frame', { frames }));
        return;
      }
      let frame;
      try {
        frame = JSON.parse(line);
      } catch (error) {
        fail(protocolError('Worker stdout was not newline-delimited JSON-RPC', {
          line,
          cause: error,
          frames,
        }));
        return;
      }
      if (frame?.jsonrpc !== '2.0' || typeof frame !== 'object' || Array.isArray(frame)) {
        fail(protocolError('Worker emitted a non-JSON-RPC stdout frame', { frame, frames }));
        return;
      }
      frames.push(frame);
      if (typeof frame.method === 'string') methods.push(frame.method);
      if (frame.id !== undefined && (Object.hasOwn(frame, 'result') || Object.hasOwn(frame, 'error'))) {
        const waiter = pending.get(frame.id);
        if (!waiter) {
          fail(protocolError(`Worker answered unknown JSON-RPC id ${String(frame.id)}`, { frames }));
          return;
        }
        pending.delete(frame.id);
        if (frame.error) {
          const error = protocolError(`JSON-RPC ${waiter.method} failed: ${frame.error.message}`, {
            rpcCode: frame.error.code,
            rpcError: frame.error,
            frames,
          });
          waiter.reject(error);
        } else {
          waiter.resolve(frame.result);
        }
      }
    }
  });

  async function request(method, params = {}) {
    if (failure) throw failure;
    const id = nextId++;
    methods.push(method);
    const response = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, method });
    });
    const timeout = setTimeout(() => {
      fail(protocolError(`JSON-RPC ${method} timed out`, { frames, stderr }));
    }, timeoutMs);
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return await response;
    } finally {
      clearTimeout(timeout);
    }
  }

  const result = {
    launcher: script,
    args: scriptArgs,
    cwd,
    frames,
    methods,
    stderr,
    stdoutBytes: 0,
    stderrBytes: 0,
    exitCode: undefined,
    initialize: undefined,
    negativeControl: undefined,
    prompt: undefined,
    wait: undefined,
    waitError: undefined,
    control: {
      model,
      maxTokens,
      approvalRequests: false,
      userQuestions: false,
    },
  };

  try {
    result.initialize = await request('initialize', {
      cwd,
      provider: 'deepseek-official',
      model,
      maxTokens,
      approvalRequests: false,
      capabilities: { userQuestions: false },
    });

    if (mode === 'shutdown') {
      try {
        await request('session/wait', { sessionId: 'wp0-unknown-session' });
        throw protocolError('Unknown-session negative control unexpectedly succeeded', { frames });
      } catch (error) {
        if (error.rpcCode === undefined) throw error;
        result.negativeControl = {
          method: 'session/wait',
          rejected: true,
          rpcCode: error.rpcCode,
          message: error.rpcError.message,
        };
      }
      await request('shutdown');
    } else if (mode === 'model') {
      result.prompt = await request('session/prompt', {
        sessionId,
        contentBlocks: [{ type: 'text', text: promptText }],
      });
      try {
        result.wait = await request('session/wait', { sessionId });
      } catch (error) {
        if (error.rpcCode === undefined) throw error;
        result.waitError = {
          rpcCode: error.rpcCode,
          message: error.rpcError.message,
        };
      }
      await request('shutdown');
    } else if (mode === 'eof') {
      child.stdin.end();
    } else {
      throw new TypeError(`Unknown stdio probe mode: ${mode}`);
    }

    const exitResult = await Promise.race([
      exit,
      new Promise((_, reject) => {
        const timer = setTimeout(() => {
          fail(protocolError('Worker exit timed out', { frames, stderr }));
          reject(failure);
        }, timeoutMs);
        timer.unref();
      }),
    ]);
    if (failure) throw failure;
    if (exitResult.code !== 0 || exitResult.signal !== null) {
      throw protocolError('Worker did not exit cleanly', { exitResult, frames, stderr });
    }
    if (stdoutBuffer.length > 0) {
      throw protocolError('Worker exited with an unterminated stdout frame', { stdoutBuffer, frames });
    }
    result.exitCode = exitResult.code;
    result.stderr = stderr;
    result.stdoutBytes = Buffer.byteLength(frames.map((frame) => `${JSON.stringify(frame)}\n`).join(''));
    result.stderrBytes = Buffer.byteLength(stderr);
    return result;
  } catch (error) {
    error.evidence = { ...result, stderr, failure: error.message };
    throw error;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    child.stdout.removeAllListeners();
    child.stderr.removeAllListeners();
  }
}
