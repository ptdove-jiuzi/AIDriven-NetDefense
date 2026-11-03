/**
 * Two-channel bounded queue with a priority reserve on both dimensions (§5.1, §5.2).
 *
 * `normal` events may only fill `maxEvents * (1 - ratio)` entries and
 * `maxBytes * (1 - ratio)` bytes; the reserved remainder is exclusively for `high`
 * events. A rejection always names the dimension that failed so the gap ledger can
 * distinguish a count overrun from a byte overrun.
 *
 * A single event is bounded by `maxEventBytes` (the same constant the collector uses),
 * never by the whole queue budget: one event must not be able to occupy a reserved
 * priority window.
 *
 * Each channel is an array with a head index instead of `Array#shift()`, so draining a
 * full 100k queue stays linear. The backing array is compacted in place once the dead
 * prefix is both large and dominant.
 */

import { CollectorError, ERROR_CODES, assertInteger } from './errors.js';
import { measureEventBytes, priorityOfEvent } from './events.js';
import { LIMITS } from './limits.js';

export const QUEUE_PRIORITIES = Object.freeze(['high', 'normal']);

export const QUEUE_REJECTION_REASONS = Object.freeze([
  'event_too_large',
  'queue_full_events',
  'queue_full_bytes',
]);

const COMPACT_THRESHOLD = 1_024;

function createChannel() {
  return { items: [], head: 0 };
}

function channelLength(channel) {
  return channel.items.length - channel.head;
}

function channelPush(channel, entry) {
  channel.items.push(entry);
}

function channelShift(channel) {
  if (channel.head >= channel.items.length) {
    return null;
  }
  const entry = channel.items[channel.head];
  channel.items[channel.head] = undefined;
  channel.head += 1;
  if (channel.head > COMPACT_THRESHOLD && channel.head * 2 >= channel.items.length) {
    channel.items = channel.items.slice(channel.head);
    channel.head = 0;
  }
  return entry;
}

function channelTakeAll(channel) {
  if (channel.head >= channel.items.length) {
    channel.items = [];
    channel.head = 0;
    return [];
  }
  const drained = channel.head === 0 ? channel.items : channel.items.slice(channel.head);
  channel.items = [];
  channel.head = 0;
  return drained;
}

export function createEventQueue({
  maxEvents = LIMITS.queueMaxEvents,
  maxBytes = LIMITS.queueMaxBytes,
  maxEventBytes = LIMITS.maxEventBytes,
  priorityReserveRatio = LIMITS.queuePriorityReserveRatio,
  measure = measureEventBytes,
} = {}) {
  assertInteger('maxEvents', maxEvents, { min: 1 });
  assertInteger('maxBytes', maxBytes, { min: 1 });
  assertInteger('maxEventBytes', maxEventBytes, { min: 1 });
  if (typeof priorityReserveRatio !== 'number' || !Number.isFinite(priorityReserveRatio)
    || priorityReserveRatio < 0 || priorityReserveRatio >= 1) {
    throw new CollectorError(
      ERROR_CODES.INVALID_ARGUMENT,
      'priorityReserveRatio must be a finite number in [0, 1)',
      { priorityReserveRatio },
    );
  }
  if (typeof measure !== 'function') {
    throw new CollectorError(ERROR_CODES.INVALID_ARGUMENT, 'measure must be a function');
  }

  const normalEventsLimit = Math.floor(maxEvents * (1 - priorityReserveRatio));
  const normalBytesLimit = Math.floor(maxBytes * (1 - priorityReserveRatio));

  const channels = { high: createChannel(), normal: createChannel() };
  const totals = { events: 0, bytes: 0, highEvents: 0, highBytes: 0, normalEvents: 0, normalBytes: 0 };
  const peak = { events: 0, bytes: 0 };
  const rejected = {
    total: 0,
    byReason: Object.fromEntries(QUEUE_REJECTION_REASONS.map((reason) => [reason, 0])),
  };
  let accepted = 0;

  const limits = Object.freeze({ maxEvents, maxBytes, maxEventBytes, normalEventsLimit, normalBytesLimit });

  function reject(reason, sizeBytes) {
    rejected.total += 1;
    rejected.byReason[reason] += 1;
    return Object.freeze({ accepted: false, reason, sizeBytes, limits });
  }

  function release(entry) {
    totals.events -= 1;
    totals.bytes -= entry.sizeBytes;
    if (entry.priority === 'high') {
      totals.highEvents -= 1;
      totals.highBytes -= entry.sizeBytes;
    } else {
      totals.normalEvents -= 1;
      totals.normalBytes -= entry.sizeBytes;
    }
  }

  return Object.freeze({
    admit(event, { priority = null, sourceId = null, sizeBytes = undefined } = {}) {
      const measured = sizeBytes === undefined ? measure(event) : sizeBytes;
      assertInteger('event size', measured, { min: 0 });
      if (sourceId !== null && typeof sourceId !== 'string') {
        throw new CollectorError(ERROR_CODES.INVALID_ARGUMENT, 'sourceId must be null or a string');
      }

      const resolvedPriority = priority === null || priority === undefined ? priorityOfEvent(event) : priority;
      if (!QUEUE_PRIORITIES.includes(resolvedPriority)) {
        throw new CollectorError(
          ERROR_CODES.INVALID_ARGUMENT,
          `Unknown queue priority: ${String(resolvedPriority)}`,
          { priority: typeof resolvedPriority === 'string' ? resolvedPriority : null },
        );
      }

      if (measured > maxEventBytes) {
        return reject('event_too_large', measured);
      }

      const eventLimit = resolvedPriority === 'high' ? maxEvents : normalEventsLimit;
      const byteLimit = resolvedPriority === 'high' ? maxBytes : normalBytesLimit;

      if (totals.events + 1 > eventLimit) {
        return reject('queue_full_events', measured);
      }
      if (totals.bytes + measured > byteLimit) {
        return reject('queue_full_bytes', measured);
      }

      channelPush(channels[resolvedPriority], Object.freeze({
        event,
        sizeBytes: measured,
        priority: resolvedPriority,
      }));
      totals.events += 1;
      totals.bytes += measured;
      if (resolvedPriority === 'high') {
        totals.highEvents += 1;
        totals.highBytes += measured;
      } else {
        totals.normalEvents += 1;
        totals.normalBytes += measured;
      }
      accepted += 1;
      peak.events = Math.max(peak.events, totals.events);
      peak.bytes = Math.max(peak.bytes, totals.bytes);

      return Object.freeze({ accepted: true, sizeBytes: measured, events: totals.events, bytes: totals.bytes });
    },

    dequeue() {
      const channel = channelLength(channels.high) > 0 ? channels.high : channels.normal;
      const entry = channelShift(channel);
      if (entry === null) {
        return null;
      }
      release(entry);
      return entry.event;
    },

    drain() {
      const drained = [];
      for (const name of ['high', 'normal']) {
        for (const entry of channelTakeAll(channels[name])) {
          release(entry);
          drained.push(entry.event);
        }
      }
      return drained;
    },

    stats() {
      return Object.freeze({
        events: totals.events,
        bytes: totals.bytes,
        highEvents: totals.highEvents,
        highBytes: totals.highBytes,
        normalEvents: totals.normalEvents,
        normalBytes: totals.normalBytes,
        limits,
        accepted,
        rejected: Object.freeze({ total: rejected.total, byReason: Object.freeze({ ...rejected.byReason }) }),
        peak: Object.freeze({ ...peak }),
      });
    },

    clear() {
      channels.high = createChannel();
      channels.normal = createChannel();
      totals.events = 0;
      totals.bytes = 0;
      totals.highEvents = 0;
      totals.highBytes = 0;
      totals.normalEvents = 0;
      totals.normalBytes = 0;
      peak.events = 0;
      peak.bytes = 0;
      accepted = 0;
      rejected.total = 0;
      for (const reason of QUEUE_REJECTION_REASONS) {
        rejected.byReason[reason] = 0;
      }
    },
  });
}
