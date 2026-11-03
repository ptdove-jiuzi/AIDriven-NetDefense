/**
 * control-channel.mjs — the NDJSON contract between the service host and its child.
 *
 * The host owns the process tree; the child owns the work. They only need three
 * messages, and keeping the set closed is the point — a control channel with an open
 * vocabulary ends up as a second, unaudited API:
 *
 *   child  → host   {"event":"ready","port":8787,"pid":1234}
 *   child  → host   {"event":"stopping","reason":"service-stop"}
 *   host   → child  {"cmd":"stop"}
 *
 * A line that is not valid JSON or not one of these is logged and ignored; it is not
 * forwarded anywhere, because the child's stdout is not a place to smuggle input.
 */

export const CONTROL_COMMANDS = Object.freeze({ stop: 'stop' });

export const CONTROL_EVENTS = Object.freeze({
  ready: 'ready',
  stopping: 'stopping',
});

/**
 * Split a byte stream into lines and hand each complete one to `onLine`.
 *
 * @param {NodeJS.ReadableStream} stream
 * @param {(line: string) => void} onLine
 * @param {{ maxLineBytes?: number }} [options]
 * @returns {() => void} Detach.
 */
export function readLines(stream, onLine, { maxLineBytes = 64 * 1024 } = {}) {
  let buffer = '';
  const onData = (chunk) => {
    buffer += chunk.toString('utf8');
    if (buffer.length > maxLineBytes && !buffer.includes('\n')) {
      // A child that never terminates a line is broken, not chatty.
      buffer = '';
      return;
    }
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line !== '') onLine(line);
      index = buffer.indexOf('\n');
    }
  };
  stream.on('data', onData);
  stream.setEncoding?.('utf8');
  return () => stream.off('data', onData);
}

/** Parse one control line, returning `null` for anything outside the closed set. */
export function parseControlLine(line) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object') return null;
  if (typeof value.event === 'string' && Object.values(CONTROL_EVENTS).includes(value.event)) {
    return { kind: 'event', event: value.event, payload: value };
  }
  if (typeof value.cmd === 'string' && Object.values(CONTROL_COMMANDS).includes(value.cmd)) {
    return { kind: 'command', cmd: value.cmd, payload: value };
  }
  return null;
}

export function encodeControl(message) {
  return `${JSON.stringify(message)}\n`;
}

/** The message the host sends when the SCM (or the operator) asks the service to stop. */
export function stopCommand(reason = 'service-stop') {
  return { cmd: CONTROL_COMMANDS.stop, reason };
}

/** The message the child sends once it is serving. */
export function readyEvent({ port, pid, version }) {
  return { event: CONTROL_EVENTS.ready, port, pid, version };
}
