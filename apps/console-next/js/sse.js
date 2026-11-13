/**
 * AIDriven NetDefense · WebUI v2 · SSE 客户端（fetch POST 流）
 * B2 / PT-dove
 *
 * 合同：docs/implementation/CONSOLE-V2-CONTRACT.md §3.1–§3.4 / §7.4 / §7.9
 *
 * - 传输：`fetch(POST)` + `response.body.getReader()` + `TextDecoder` 增量解码；
 *   不用 EventSource（EventSource 只能 GET，合同禁止 chat 的 GET 版本）。
 * - 解析：`\r\n` / `\r` / `\n` 三种行结束；多行 `data:` 以 `\n` 拼接；`: ping`
 *   注释（心跳）忽略；未知字段忽略；`event:` 缺省为 `message`。
 * - 累积（§3.3）：按 `seq` 升序拼接 `delta.text`；`seq` 重复不重复插入（去重键 = seq）；
 *   收到 `done|error` 终态后停止读取、保留已累积文本、把 `usage` 挂在结果尾部。
 * - 中断：未收到终态就断流 → `terminal:'interrupted'`，保留文本，**不自动重连**
 *   （chat 不幂等，重连会重复计费）。
 * - 取消：`abort()` → AbortController + reader.cancel()，已收文本保留，
 *   `terminal:'aborted'`。
 *
 * 对外：createSseParser / createSseAccumulator / openSsePost / SSE_EVENT_NAMES
 */

import { isPlainObject } from './util.js';

/** 服务端可能发的事件名（§3.2）；未知事件名仍计数但不影响解析。 */
export const SSE_EVENT_NAMES = Object.freeze(['delta', 'tool', 'usage', 'done', 'error']);

/** 单行缓冲上限，防止异常流把内存打满（超过视为协议错误）。 */
export const SSE_MAX_BUFFER = 1024 * 1024;

/**
 * 增量 SSE 帧解析器。
 *
 * @param {{onEvent?: Function|null, onComment?: Function|null, onMalformed?: Function|null}} [options]
 * @returns {{
 *   push(chunk:string): object[],
 *   end(): object[],
 *   stats(): {dispatched:number, comments:number, malformed:number, terminated:boolean, buffered:number},
 * }}
 */
export function createSseParser(options = {}) {
  const opts = options == null ? {} : options;
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null;
  const onComment = typeof opts.onComment === 'function' ? opts.onComment : null;
  const onMalformed = typeof opts.onMalformed === 'function' ? opts.onMalformed : null;

  let buffer = '';
  let eventName = '';
  let dataLines = [];
  let dispatched = 0;
  let comments = 0;
  let malformed = 0;
  let terminated = false;

  function deliver(event) {
    dispatched += 1;
    if (event.event === 'done' || event.event === 'error') terminated = true;
    if (onEvent) {
      try {
        onEvent(event);
      } catch (error) {
        if (typeof console !== 'undefined' && console.error) console.error('[sse] onEvent failed', error);
      }
    }
    return event;
  }

  /** 空行 = 派发当前事件（SSE 规范：没有 data 行就不派发）。 */
  function dispatch() {
    if (dataLines.length === 0) {
      eventName = '';
      return null;
    }
    const name = eventName === '' ? 'message' : eventName;
    const payloadText = dataLines.join('\n');
    dataLines = [];
    eventName = '';
    let data = null;
    if (payloadText !== '') {
      try {
        data = JSON.parse(payloadText);
      } catch {
        malformed += 1;
        const frame = {
          event: 'error',
          data: {
            code: 'SSE_MALFORMED',
            message: 'event stream frame is not valid JSON',
            rawLength: payloadText.length,
            local: true,
          },
        };
        if (onMalformed) {
          try {
            onMalformed(frame);
          } catch {
            /* 诊断回调失败不影响解析 */
          }
        }
        return deliver(frame);
      }
    }
    return deliver({ event: name, data });
  }

  function feedLine(line) {
    if (line === '') return dispatch();
    if (line.startsWith(':')) {
      comments += 1;
      if (onComment) {
        try {
          onComment(line.slice(1).trim());
        } catch {
          /* 心跳注释只用于诊断 */
        }
      }
      return null;
    }
    const colon = line.indexOf(':');
    let field;
    let value;
    if (colon === -1) {
      field = line;
      value = '';
    } else {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
    }
    if (field === 'event') {
      eventName = value;
    } else if (field === 'data') {
      dataLines.push(value);
    }
    // id / retry 字段故意忽略：本客户端不做 Last-Event-ID 续传（§3.3 不自动重连）。
    return null;
  }

  /**
   * 喂一段解码后的文本，返回本段派发的事件（同步）。
   * @param {string} chunk
   * @returns {object[]}
   */
  function push(chunk) {
    const events = [];
    if (terminated) return events;
    buffer += typeof chunk === 'string' ? chunk : String(chunk ?? '');
    if (buffer.length > SSE_MAX_BUFFER) {
      malformed += 1;
      buffer = '';
      events.push(
        deliver({
          event: 'error',
          data: { code: 'SSE_MALFORMED', message: 'event stream buffer limit exceeded', local: true },
        }),
      );
      return events;
    }
    // 末尾孤立的 \r 可能是被切开的 \r\n 前半段：先扣住，等下一块。
    const holdCr = buffer.endsWith('\r');
    const source = holdCr ? buffer.slice(0, -1) : buffer;
    const pattern = /\r\n|\n|\r/gu;
    let start = 0;
    let match = pattern.exec(source);
    while (match !== null) {
      const line = source.slice(start, match.index);
      start = match.index + match[0].length;
      const event = feedLine(line);
      if (event) events.push(event);
      match = pattern.exec(source);
    }
    buffer = source.slice(start) + (holdCr ? '\r' : '');
    return events;
  }

  /** 流结束：把残留的半行当一行处理（末尾缺空行的最后一帧也尽量派发）。 */
  function end() {
    const events = [];
    if (terminated) return events;
    if (buffer !== '') {
      const line = buffer;
      buffer = '';
      const event = feedLine(line);
      if (event) events.push(event);
    }
    if (dataLines.length > 0) {
      const event = dispatch();
      if (event) events.push(event);
    }
    return events;
  }

  function stats() {
    return {
      dispatched,
      comments,
      malformed,
      terminated,
      buffered: buffer.length,
    };
  }

  return { push, end, stats };
}

/**
 * SSE 事件累积器（§3.3）。
 *
 * - text：按 seq 升序取每个 delta 的 text（重复 seq 只算一次）；
 * - events：全部已记录事件（按到达顺序）；
 * - usage / done / error：对应事件的数据对象；
 * - terminal：'done' | 'error' | 'aborted' | 'interrupted' | null。
 *
 * @param {{onUpdate?: Function|null}} [options]
 */
export function createSseAccumulator(options = {}) {
  const opts = options == null ? {} : options;
  const onUpdate = typeof opts.onUpdate === 'function' ? opts.onUpdate : null;

  const events = [];
  const bySeq = new Map();
  const deltas = new Map();
  let text = '';
  let usage = null;
  let done = null;
  let error = null;
  let terminal = null;
  let unknownEvents = 0;
  let duplicates = 0;
  let outOfOrder = 0;
  let lastSeq = 0;

  function recompute() {
    const ordered = [...deltas.entries()].sort((a, b) => a[0] - b[0]);
    text = ordered.map(([, value]) => value).join('');
  }

  function snapshot() {
    return {
      terminal,
      text,
      events: events.slice(),
      usage,
      done,
      error,
      stats: {
        events: events.length,
        deltas: deltas.size,
        duplicates,
        outOfOrder,
        unknownEvents,
        seqMax: lastSeq,
      },
    };
  }

  /**
   * 记录一个解析后的 SSE 事件。
   * @param {{event:string, data:object|null}} event
   * @returns {boolean} 是否被记录（重复 seq / 终态之后 → false）
   */
  function push(event) {
    if (!event || typeof event.event !== 'string') return false;
    if (terminal !== null) return false;
    const data = isPlainObject(event.data) ? event.data : null;
    const seq = data && Number.isFinite(data.seq) ? Number(data.seq) : null;
    if (seq !== null) {
      if (bySeq.has(seq)) {
        duplicates += 1;
        return false;
      }
      if (seq < lastSeq) outOfOrder += 1;
      lastSeq = Math.max(lastSeq, seq);
      bySeq.set(seq, event);
    }
    if (!SSE_EVENT_NAMES.includes(event.event)) {
      unknownEvents += 1;
      // 未知事件名仍记录（便于诊断），不参与文本累积。
      events.push(event);
      if (onUpdate) onUpdate(snapshot());
      return true;
    }
    events.push(event);
    if (event.event === 'delta') {
      // 没有 seq 的 delta 用到达顺序补一个稳定 key（服务端按合同总有 seq）。
      const key = seq === null ? Number.MAX_SAFE_INTEGER / 2 + events.length : seq;
      deltas.set(key, String(data && data.text !== undefined ? data.text : ''));
      recompute();
    } else if (event.event === 'usage') {
      usage = data;
    } else if (event.event === 'done') {
      terminal = 'done';
      done = data;
    } else if (event.event === 'error') {
      terminal = 'error';
      error = data;
    }
    if (onUpdate) onUpdate(snapshot());
    return true;
  }

  /**
   * 收尾：终态已由事件确定时保留；否则按 aborted / interrupted 落定（§3.3）。
   * @param {'aborted'|'interrupted'} [reason]
   */
  function finalize(reason) {
    if (terminal === null) {
      terminal = reason === 'aborted' ? 'aborted' : 'interrupted';
    }
    return snapshot();
  }

  return {
    push,
    finalize,
    snapshot,
    get text() {
      return text;
    },
    get terminal() {
      return terminal;
    },
    get usage() {
      return usage;
    },
    get done() {
      return done;
    },
    get error() {
      return error;
    },
    get events() {
      return events;
    },
  };
}

/**
 * 打开一个 SSE POST 流。
 *
 * @param {string} path 绝对/相对请求路径（api.js 传入含 base 的完整路径）
 * @param {object} body JSON body
 * @param {{
 *   fetchImpl?: Function|null,
 *   onEvent?: Function|null,
 *   onOpen?: Function|null,
 *   signal?: AbortSignal|null,
 *   decoder?: { decode: Function }|null,
 * }} [options]
 * @returns {{
 *   abort(reason?:string): void,
 *   done: Promise<object>,
 *   terminal: string|null,
 *   text: string,
 *   aborted: boolean,
 *   autoRetry: false,
 *   accumulator: object,
 * }}
 */
export function openSsePost(path, body, options = {}) {
  const opts = options == null ? {} : options;
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : null;
  const controller = new AbortController();
  const decoder =
    opts.decoder && typeof opts.decoder.decode === 'function'
      ? opts.decoder
      : typeof TextDecoder === 'function'
        ? new TextDecoder('utf-8')
        : null;

  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null;
  const onOpen = typeof opts.onOpen === 'function' ? opts.onOpen : null;

  const accumulator = createSseAccumulator();
  const parser = createSseParser({
    onEvent: (event) => {
      accumulator.push(event);
      if (onEvent) {
        try {
          onEvent(event);
        } catch (error) {
          if (typeof console !== 'undefined' && console.error) console.error('[sse] onEvent handler failed', error);
        }
      }
    },
  });

  let aborted = false;
  let settled = false;
  let reader = null;
  let httpError = null;
  let result = null;

  const handle = {
    abort,
    done: null,
    terminal: null,
    get text() {
      return accumulator.text;
    },
    get aborted() {
      return aborted;
    },
    autoRetry: false,
    accumulator,
    get httpError() {
      return httpError;
    },
  };

  function safeCancelReader() {
    if (!reader) return;
    try {
      const pending = reader.cancel();
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch {
      /* 取消失败不影响本地状态 */
    }
  }

  function finish(kind, extra = {}) {
    if (settled) return result;
    settled = true;
    safeCancelReader();
    const snapshot = accumulator.finalize(kind === 'aborted' ? 'aborted' : 'interrupted');
    let terminal = snapshot.terminal;
    if (terminal === null) terminal = 'interrupted';
    // HTTP 层失败没有 SSE error 事件，但语义上仍是 error（api.js 会映射成 ApiError）。
    if (extra.httpError) terminal = 'error';
    if (kind === 'aborted') terminal = 'aborted';
    result = {
      terminal,
      text: snapshot.text,
      events: snapshot.events,
      usage: snapshot.usage,
      done: snapshot.done,
      error: snapshot.error,
      interrupted: terminal === 'interrupted',
      aborted: terminal === 'aborted',
      httpStatus: extra.httpStatus ?? null,
      httpError: extra.httpError ?? httpError,
      stats: { ...snapshot.stats, parser: parser.stats() },
      autoRetry: false,
    };
    handle.terminal = terminal;
    return result;
  }

  async function readHttpError(response) {
    let payload = null;
    try {
      if (response && typeof response.json === 'function') payload = await response.json();
    } catch {
      payload = null;
    }
    const envelope = isPlainObject(payload) && isPlainObject(payload.error) ? payload.error : null;
    let retryAfter = null;
    try {
      const header = response && response.headers && typeof response.headers.get === 'function'
        ? response.headers.get('retry-after')
        : null;
      const parsed = Number(header);
      if (Number.isFinite(parsed)) retryAfter = parsed;
    } catch {
      retryAfter = null;
    }
    return {
      status: response && Number.isFinite(response.status) ? Number(response.status) : null,
      code: envelope && typeof envelope.code === 'string' ? envelope.code : null,
      message: envelope && typeof envelope.message === 'string' ? envelope.message : '',
      details: envelope && isPlainObject(envelope.details) ? envelope.details : null,
      retryAfter,
    };
  }

  async function run() {
    try {
      if (!fetchImpl) throw new Error('fetch is not available');
      const headers = { accept: 'text/event-stream' };
      // 额外头（目前只有 host 层写保护标记 x-console-v2: 1）；像 authorization/cookie
      // 这类凭据头一律拒绝透传，保证浏览器侧永远不持有凭据（合同 §1.1）。
      if (isPlainObject(opts.headers)) {
        for (const [name, value] of Object.entries(opts.headers)) {
          const key = String(name).toLowerCase();
          if (key === 'authorization' || key === 'cookie' || key === 'x-aegis-csrf') continue;
          if (typeof value === 'string') headers[key] = value;
        }
      }
      const init = {
        method: 'POST',
        headers,
        credentials: 'same-origin',
        signal: controller.signal,
      };
      if (body !== undefined && body !== null) {
        headers['content-type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      const response = await fetchImpl(path, init);
      if (!response || response.ok === false) {
        const detail = await readHttpError(response);
        if (detail.code) {
          httpError = { ...detail, code: detail.code };
        } else {
          httpError = {
            ...detail,
            code: detail.status !== null && detail.status >= 500 ? 'INTERNAL' : 'HTTP_ERROR',
          };
        }
        return finish('error', {
          httpStatus: detail.status,
          httpError,
        });
      }
      if (onOpen) {
        try {
          onOpen(response);
        } catch (error) {
          if (typeof console !== 'undefined' && console.error) console.error('[sse] onOpen handler failed', error);
        }
      }
      if (!response.body || typeof response.body.getReader !== 'function') {
        httpError = { status: null, code: 'BAD_RESPONSE', message: 'response body is not a readable stream' };
        return finish('error', { httpStatus: null, httpError });
      }
      reader = response.body.getReader();
      while (true) {
        const chunk = await reader.read();
        if (!chunk) break;
        if (chunk.value && decoder) {
          parser.push(decoder.decode(chunk.value, { stream: true }));
        } else if (chunk.value) {
          parser.push(String(chunk.value));
        }
        if (accumulator.terminal !== null) break;
        if (chunk.done) break;
      }
      if (!accumulator.terminal) parser.end();
      if (accumulator.terminal === 'done') return finish('done');
      if (accumulator.terminal === 'error') return finish('error');
      if (aborted) return finish('aborted');
      return finish('interrupted');
    } catch (error) {
      if (aborted || (error && error.name === 'AbortError')) return finish('aborted');
      httpError = null;
      return finish('interrupted');
    }
  }

  function abort() {
    if (aborted || settled) return;
    aborted = true;
    try {
      controller.abort();
    } catch {
      /* 已中止 */
    }
    safeCancelReader();
  }

  if (opts.signal && typeof opts.signal.addEventListener === 'function') {
    if (opts.signal.aborted) abort();
    else opts.signal.addEventListener('abort', abort, { once: true });
  }

  handle.done = run().catch((error) => {
    if (typeof console !== 'undefined' && console.error) console.error('[sse] stream failed', error);
    return finish(aborted ? 'aborted' : 'interrupted');
  });
  return handle;
}
