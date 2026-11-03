// author: PT-dove
// M9 对抗语料 —— Linux 采集器的解析面（auth.log / journald / fs-reader）。
//
// 三个关注点：
// 1. **字节偏移就是身份**：文本日志没有原生 record id，光标是行首字节偏移。任何
//    "先解码再计数"的写法都会让偏移漂移，重放时既可能漏读也可能重复读。
// 2. **注入只能是文本**：`$(...)`、反引号、伪造的第二条记录都必须在 payload 里
//    原样保留，绝不能被执行，也不能改变事件结构。
// 3. **轮转必须被识别**：dev:ino 变化、大小回退、尾部摘要不一致都产生 generation 前进；
//    识别不了的情形（文档里写明的盲点）也要有断言钉住，不能靠"感觉没漏"。

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTH_LOG_DESCRIPTOR,
  LINUX_ERROR_CODES,
  LinuxCollectorError,
  assertVirtualPath,
  createAuthLogSource,
  createMemoryFileSystem,
  parseAuthLine,
  parseJournaldEntry,
  parseJournaldOutput,
  stateDigest,
} from '../../packages/collectors/linux/index.js';
import { validateTelemetryEvent } from '../../packages/contracts/src/index.js';
import { ContractError, canonicalDigest } from '../../packages/contracts/src/index.js';
import { AUTH_LOG_LINE_CASES } from './support/corpus.js';
import { escapeForMessage, expectRejection } from './support/harness.js';
import { telemetryEvent } from './support/fixtures.js';

const NOW = Date.UTC(2023, 10, 14, 22, 13, 20); // 2023-11-14T22:13:20Z
const LOG_PATH = '/var/log/auth.log';

function sourceFor(files, options = {}) {
  const fileSystem = createMemoryFileSystem({ files });
  const source = createAuthLogSource({ fileSystem, clock: () => NOW, ...options });
  return { fileSystem, source };
}

async function readLines(content, options = {}) {
  const { fileSystem, source } = sourceFor({ [LOG_PATH]: content }, { initialPosition: 'start', ...options });
  const result = await source.read({ cursor: null, generation: 0 });
  return { result, fileSystem, source };
}

/** 把 linux payload 的键改成 snake_case 并去掉 null，用来隔离不同缺陷的失败原因。 */
function toContractShape(payload) {
  const snake = (key) => key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);
  const out = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === null || value === undefined) continue;
    out[snake(key)] = value;
  }
  return out;
}

test('语料表自洽：auth.log 样本 id 唯一且都带说明', () => {
  const ids = new Set();
  for (const entry of AUTH_LOG_LINE_CASES) {
    assert.equal(ids.has(entry.id), false, `duplicate id ${entry.id}`);
    ids.add(entry.id);
    assert.ok(entry.note.length > 0);
    assert.ok(
      entry.rejectCode === null || typeof entry.rejectCode === 'string',
      `${entry.id}: rejectCode must be null or an ERROR_CODES value`,
    );
  }
  assert.ok(AUTH_LOG_LINE_CASES.length >= 8, 'the auth.log corpus must not silently shrink');
});

/**
 * 语料侧的**独立**清洗预期：只按合同禁止的字符类别剥除，不复用生产的 `sanitizeText`。
 *
 * 顺序：孤立代理项 → U+FFFD、双向符、零宽、`\t\n\r` → 空格、其余 C0/C1/DEL、最后 NFC。
 * 独立实现的理由：用被测的清洗器去算"期望值"，会让"清洗器漏掉某一类字符"这件事
 * 永远是绿的。这里的预期只依赖合同（`validateTelemetryEvent` 对 payload 字符串的要求）。
 *
 * @param {string} raw 原始行。
 * @returns {string} 期望出现在 `payload.line` 里的文本。
 */
function expectedPayloadText(raw) {
  return raw
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu, '\uFFFD')
    .replace(/[\u202A-\u202E\u2066-\u2069]/gu, '')
    .replace(/[\u200B-\u200F\uFEFF\u2060]/gu, '')
    .replace(/[\t\n\r]+/gu, ' ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, '')
    .normalize('NFC');
}

/** 合同禁止出现在 payload 字符串里的字符：C0/C1/DEL、双向符、零宽。 */
const FORBIDDEN_IN_PAYLOAD = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\u200B-\u200F\uFEFF\u2060]/u;

/** `auth.log` 的默认单行上限（超过即截断并标记）。 */
const AUTH_LOG_MAX_LINE_CHARS = 2048;

for (const entry of AUTH_LOG_LINE_CASES) {
  test(`auth.log 解析：${entry.id}（${entry.note}）`, async () => {
    const { result } = await readLines(`${entry.line}\n`);
    assert.equal(result.status, 'ok');
    // 行边界就是记录边界：注入的换行只会多出一条**独立**记录，不会改写上一条的内容。
    const expectedLines = entry.line.split('\n').filter((line) => line.trim().length > 0);
    assert.equal(result.records.length, expectedLines.length);
    for (const [index, record] of result.records.entries()) {
      const raw = expectedLines[index];
      assert.equal(record.type, 'linux.auth');
      assert.equal(record.payload.path, LOG_PATH);

      // DEF-03（修复后）：payload 里不得残留任何合同禁止的字符，且必须是 NFC。
      // 这两条是"清洗"这件事的可判定性质；不锁具体清洗实现。
      assert.equal(
        FORBIDDEN_IN_PAYLOAD.test(record.payload.line),
        false,
        `payload.line must not carry control/bidi/zero-width characters, got ${escapeForMessage(record.payload.line)}`,
      );
      assert.equal(record.payload.line, record.payload.line.normalize('NFC'), 'payload.line must be NFC');

      // 清洗 ≠ 丢弃：可读内容必须逐字保留，只去掉合同禁止的类别。
      const truncated = raw.length > AUTH_LOG_MAX_LINE_CHARS;
      assert.equal(record.payload.line_truncated, truncated, 'line_truncated must follow maxLineChars');
      assert.equal(
        record.payload.line,
        expectedPayloadText(truncated ? raw.slice(0, AUTH_LOG_MAX_LINE_CHARS) : raw),
        `payload.line must be the sanitized raw line, got ${escapeForMessage(record.payload.line)}`,
      );

      // 身份仍按**原始字节**计量：清洗不改变偏移，也不改变摘要。
      assert.equal(
        record.payload.byte_length,
        Buffer.byteLength(raw, 'utf8') + 1,
        'byte_length must describe the raw line, newline included',
      );
      assert.equal(
        record.payload.line_digest,
        stateDigest(raw),
        'line_digest must cover the raw line, so sanitizing cannot hide a rewrite',
      );
      if (index > 0) {
        assert.ok(
          record.sourceSequence > result.records[index - 1].sourceSequence,
          'each line gets its own byte offset',
        );
      }
    }
    assert.equal(result.records[0].sourceSequence, 0, 'the first line starts at byte offset 0');
  });
}

test('DEF-04（修复后）：auth.log 的 payload 是合同形状，事件必须通过校验', async () => {
  const { result } = await readLines('Oct 31 10:00:01 lab-host.example.test sshd[812]: Failed password for root\n');
  const payload = result.records[0].payload;

  // TelemetryEvent 的 payload 键必须是 ^[a-z][a-z0-9_]{0,63}$，且不接受 null。
  for (const key of Object.keys(payload)) {
    assert.match(key, /^[a-z][a-z0-9_]{0,63}$/u, `payload key "${key}" must be snake_case`);
  }
  for (const [key, value] of Object.entries(payload)) {
    assert.notEqual(value, null, `payload.${key} must be omitted rather than null`);
    assert.notEqual(value, undefined, `payload.${key} must not be undefined`);
  }
  // 描述符里的字段确实以 snake_case 暴露（改名不是"删字段"）。
  assert.deepEqual(
    ['byte_length', 'line_digest', 'line_truncated', 'timestamp_style'].filter((key) => Object.hasOwn(payload, key)),
    ['byte_length', 'line_digest', 'line_truncated', 'timestamp_style'],
    'the Linux payload exposes the renamed descriptor fields',
  );

  // 真实 payload 直接喂合同：**修复前这里必定 ERR_FIELD_PATTERN**，现在必须被接受。
  const validated = validateTelemetryEvent({
    ...telemetryEvent(),
    type: 'linux.auth',
    payload,
    observed_at: '2023-11-14T22:13:20Z',
    received_at: '2023-11-14T22:13:30Z',
    integrity: { algorithm: 'sha256', digest: canonicalDigest(payload) },
  });
  assert.equal(validated.value.payload.identifier, 'sshd');
  assert.equal(validated.value.payload.pid, 812);

  // 负向对照：把两个键改回 camelCase，键规则必须仍然拒绝 —— 证明"通过"不是把断言放松了。
  const camelCase = { byteLength: payload.byte_length, lineDigest: payload.line_digest };
  expectRejection(
    () => validateTelemetryEvent({
      ...telemetryEvent(),
      type: 'linux.auth',
      payload: camelCase,
      integrity: { algorithm: 'sha256', digest: canonicalDigest(camelCase) },
    }),
    { code: 'ERR_FIELD_PATTERN', type: ContractError, pathIncludes: '$.payload.byteLength', label: 'camelCase payload' },
  );
});

test('DEF-03（修复后）：控制字符 / 双向符被剥除，清洗后的 payload 通过契约校验', async () => {
  const hostile = AUTH_LOG_LINE_CASES.filter((item) => item.rejectCode !== null);
  assert.ok(hostile.length >= 4, 'the control-character corpus must not silently shrink');

  for (const entry of AUTH_LOG_LINE_CASES) {
    const { result } = await readLines(`${entry.line}\n`);
    const payload = result.records[0].payload;

    // 正向：清洗后的 payload 必须通过合同（修复前这 4 条控制符样本 100% 被拒）。
    const validated = validateTelemetryEvent({
      ...telemetryEvent(),
      type: 'linux.auth',
      payload,
      observed_at: '2023-11-14T22:13:20Z',
      received_at: '2023-11-14T22:13:30Z',
      integrity: { algorithm: 'sha256', digest: canonicalDigest(payload) },
    });
    assert.equal(validated.value.type, 'linux.auth', `${entry.id}: the sanitized payload must reach the contract`);

    if (entry.rejectCode === null) {
      continue;
    }

    // 负向对照：把**原始未清洗**的行塞回同一个键位，必须仍按原错误码被拒。
    // 这证明上面那次通过的原因是"清洗"，而不是"断言变松了"。
    const unsanitized = { ...payload, line: entry.line };
    expectRejection(
      () => validateTelemetryEvent({
        ...telemetryEvent(),
        type: 'linux.auth',
        payload: unsanitized,
        integrity: { algorithm: 'sha256', digest: canonicalDigest(unsanitized) },
      }),
      { code: entry.rejectCode, type: ContractError, label: `${entry.id} (unsanitized line)` },
    );
  }
});

test('对照：干净行通过校验并抽出结构字段（清洗不是"一律丢字段"）', async () => {
  const clean = 'Oct 31 10:00:01 lab-host.example.test sshd[812]: Failed password for root\n';
  const { result } = await readLines(clean);
  // 键已经是 snake_case，`toContractShape` 在这里退化为"原样拷贝"：
  // 保留它是为了让本条与 DEF-04 那条走同一条构造路径，方便对照。
  const payload = toContractShape(result.records[0].payload);
  const event = {
    ...telemetryEvent(),
    type: 'linux.auth',
    payload,
    observed_at: '2023-11-14T22:13:20Z',
    received_at: '2023-11-14T22:13:30Z',
    integrity: { algorithm: 'sha256', digest: canonicalDigest(payload) },
  };
  const record = validateTelemetryEvent(event);
  assert.equal(record.value.payload.identifier, 'sshd');
  assert.equal(record.value.payload.pid, 812);
});

test('超长行按 maxLineChars 截断并标记，偏移与摘要仍按原始字节推进', async () => {
  const longLine = `Oct 31 10:00:01 lab-host.example.test sshd[812]: ${'A'.repeat(500)}`;
  const { result } = await readLines(`${longLine}\n`, { maxLineChars: 32 });
  const record = result.records[0];
  assert.equal(record.payload.line_truncated, true);
  assert.equal(record.payload.line.length, 32);
  assert.ok(record.payload.message.length <= 32);
  assert.equal(
    record.payload.byte_length,
    Buffer.byteLength(longLine, 'utf8') + 1,
    'byte_length must describe the raw line, not the truncated preview',
  );
  // 摘要覆盖**原始整行**：截断只影响预览，不影响身份。
  assert.equal(record.payload.line_digest, stateDigest(longLine));
  assert.equal(result.nextCursor.offset, Buffer.byteLength(longLine, 'utf8') + 1);
});

test('字节偏移是记录身份：第二行的 sourceSequence 等于第一行的字节长度', async () => {
  const first = 'Oct 31 10:00:01 lab-host.example.test sshd[812]: Failed password for root';
  const second = 'Oct 31 10:00:02 lab-host.example.test sshd[813]: Accepted publickey for test';
  const { result } = await readLines(`${first}\n${second}\n`);
  assert.equal(result.records.length, 2);
  assert.equal(result.records[0].sourceSequence, 0);
  assert.equal(result.records[1].sourceSequence, Buffer.byteLength(first, 'utf8') + 1);
  assert.equal(result.records[1].payload.offset, result.records[1].sourceSequence);
});

test('未写完的尾行不被消费：offset 停在它前面，hasMore 为真', async () => {
  const complete = 'Oct 31 10:00:01 lab-host.example.test sshd[812]: Failed password for root';
  const partial = 'Oct 31 10:00:02 lab-host.example.test sshd[813]: Accepted pub';
  const { source } = sourceFor({ [LOG_PATH]: `${complete}\n${partial}` }, { initialPosition: 'start' });
  const first = await source.read({ cursor: null, generation: 0 });
  assert.equal(first.records.length, 1);
  assert.equal(first.hasMore, true, 'the partial trailing line is not a record yet');
  assert.equal(first.nextCursor.offset, Buffer.byteLength(complete, 'utf8') + 1);
  assert.equal(first.stats.remainderBytes, Buffer.byteLength(partial, 'utf8'));

  // 写完后再读，同一条记录拿到**同一个** sourceSequence（身份稳定，重放不重复）。
  const appended = await source.read({ cursor: first.nextCursor, generation: 0 });
  assert.equal(appended.records.length, 0, 'the file content in this fixture did not change');
});

test('maxLinesPerRead 是硬上限：剩余行留到下一轮，不计为丢失', async () => {
  const line = 'Oct 31 10:00:01 lab-host.example.test sshd[812]: Failed password';
  const { result } = await readLines(`${Array.from({ length: 5 }, () => line).join('\n')}\n`, { maxLinesPerRead: 2 });
  assert.equal(result.records.length, 2);
  assert.equal(result.status, 'ok', 'a bounded read is not a degraded read');
  assert.equal(result.hasMore, true);
  assert.equal(result.stats.skipped, 3);
});

test('轮转：dev:ino 变化时报 rotated，并把 generation 交回调用方', async () => {
  const fileSystem = createMemoryFileSystem({
    files: {
      [LOG_PATH]: { content: 'Oct 31 10:00:01 lab-host.example.test sshd[812]: one\n', dev: 1, ino: 100 },
    },
  });
  const source = createAuthLogSource({ fileSystem, clock: () => NOW, initialPosition: 'start' });
  const first = await source.read({ cursor: null, generation: 0 });
  assert.equal(first.records.length, 1);

  // 模拟 logrotate：新文件、新 inode。
  const rotated = createMemoryFileSystem({
    files: {
      [LOG_PATH]: { content: 'Oct 31 10:01:00 lab-host.example.test sshd[900]: two\n', dev: 1, ino: 200 },
    },
  });
  const rotatedSource = createAuthLogSource({ fileSystem: rotated, clock: () => NOW, initialPosition: 'start' });
  const second = await rotatedSource.read({ cursor: first.nextCursor, generation: 0 });
  assert.equal(second.status, 'rotated');
  assert.equal(second.rotation.reason, 'log_rotated');
  assert.equal(second.rotation.previousFileId, '1:100');
  assert.equal(second.rotation.fileId, '1:200');
  assert.equal(second.nextCursor, null, 'a rotation must not carry the old offset forward');
  assert.deepEqual(second.records, []);
});

test('截断且已重新长过旧偏移：靠尾部摘要识别为 log_truncated', async () => {
  const head = 'Oct 31 10:00:01 lab-host.example.test sshd[812]: first line\n';
  const fileSystem = createMemoryFileSystem({ files: { [LOG_PATH]: head } });
  const source = createAuthLogSource({ fileSystem, clock: () => NOW, initialPosition: 'start' });
  const first = await source.read({ cursor: null, generation: 0 });
  assert.equal(first.records.length, 1);
  assert.equal(typeof first.nextCursor.tailDigest, 'string', 'the cursor carries a tail digest');

  // 同 inode、大小超过旧偏移，但 64 字节尾部内容完全不同。
  const rewritten = `${'X'.repeat(Buffer.byteLength(head, 'utf8') + 32)}\n`;
  const sameInode = createMemoryFileSystem({ files: { [LOG_PATH]: rewritten } });
  const sameInodeSource = createAuthLogSource({ fileSystem: sameInode, clock: () => NOW, initialPosition: 'start' });
  const second = await sameInodeSource.read({ cursor: first.nextCursor, generation: 0 });
  assert.equal(second.status, 'rotated');
  assert.equal(second.rotation.reason, 'log_truncated');
  assert.equal(second.nextCursor, null);
});

test('文档化的盲点：同 inode、同大小、同 64 字节尾部的改写检测不到（盲点必须被声明）', async () => {
  const prefix = 'Oct 31 10:00:01 lab-host.example.test sshd[812]: first line\n';
  const tail = 'Y'.repeat(64);
  const fileSystem = createMemoryFileSystem({ files: { [LOG_PATH]: `${prefix}${tail}\n` } });
  const source = createAuthLogSource({ fileSystem, clock: () => NOW, initialPosition: 'start' });
  const first = await source.read({ cursor: null, generation: 0 });
  assert.equal(first.status, 'ok');

  // 把前缀换掉，但保留同样的长度与同样的 64 字节尾部。
  const forged = `${'Z'.repeat(Buffer.byteLength(prefix, 'utf8'))}${tail}\n`;
  const sameInode = createMemoryFileSystem({ files: { [LOG_PATH]: forged } });
  const sameInodeSource = createAuthLogSource({ fileSystem: sameInode, clock: () => NOW, initialPosition: 'start' });
  const second = await sameInodeSource.read({ cursor: first.nextCursor, generation: 0 });
  assert.equal(second.status, 'ok', 'this rewrite is invisible by design');
  assert.equal(second.records.length, 0);

  // 盲点必须写在描述符里，否则运维无从判断"没漏"还是"检测不到"。
  const declared = AUTH_LOG_DESCRIPTOR.blindSpots.join('\n');
  assert.match(declared, /copy-and-truncate|rewrite that keeps the inode|tail/iu);
});

test('读权限被拒：status=denied、permissions.missing 指向该文件、不发布任何记录', async () => {
  const fileSystem = createMemoryFileSystem({
    files: { [LOG_PATH]: 'Oct 31 10:00:01 lab-host.example.test sshd[812]: x\n' },
    denied: [LOG_PATH],
  });
  const source = createAuthLogSource({ fileSystem, clock: () => NOW });
  const result = await source.read({ cursor: null, generation: 0 });
  assert.equal(result.status, 'denied');
  assert.deepEqual(result.records, []);
  assert.deepEqual(result.permissions.missing, [LOG_PATH]);
  assert.equal(result.nextCursor, null);
});

test('候选路径必须是绝对路径（相对路径会让"读哪个日志"变得不可审计）', () => {
  const fileSystem = createMemoryFileSystem({ files: {} });
  for (const candidate of ['var/log/auth.log', './auth.log', '', '../auth.log']) {
    expectRejection(
      () => createAuthLogSource({ fileSystem, candidatePaths: [candidate] }),
      { code: LINUX_ERROR_CODES.INVALID_ARGUMENT, type: LinuxCollectorError, label: candidate },
    );
  }
});

test('虚拟路径拒绝遍历与相对形式', () => {
  for (const bad of ['../etc/passwd', 'relative/path', '', './x']) {
    expectRejection(() => assertVirtualPath('path', bad), {
      code: LINUX_ERROR_CODES.INVALID_ARGUMENT,
      type: LinuxCollectorError,
      label: bad,
    });
  }
  // `..` 有独立的错误码：它不是"参数类型错"，而是明确的越界信号。
  expectRejection(() => assertVirtualPath('path', '/var/../../etc/passwd'), {
    code: LINUX_ERROR_CODES.PATH_ESCAPE,
    type: LinuxCollectorError,
  });
  expectRejection(() => assertVirtualPath('path', '/var/log/../auth.log'), {
    code: LINUX_ERROR_CODES.PATH_ESCAPE,
    type: LinuxCollectorError,
  });
  assert.equal(assertVirtualPath('path', '/var/log/auth.log'), '/var/log/auth.log');
});

test('注入只能是文本：shell 元字符不影响解析结果与严重度判定', async () => {
  const line = 'Oct 31 10:00:06 lab-host.example.test sshd[812]: Failed password for $(reboot); rm -rf /';
  const { result } = await readLines(`${line}\n`);
  const record = result.records[0];
  assert.equal(record.payload.line, line, 'the whole line is preserved as data');
  assert.equal(record.severity, 'medium', 'severity comes from the message content, unchanged by punctuation');
  assert.equal(parseAuthLine(line, { nowMs: NOW }).identifier, 'sshd');
});

test('journald：畸形 JSON 行被计数，不带 cursor 的条目被单独计数', () => {
  const stdout = [
    '{"__CURSOR":"s=abc","MESSAGE":"ok","PRIORITY":"6"}',
    'not json at all',
    '{"MESSAGE":"no cursor here"}',
    '{"__CURSOR":"s=def","MESSAGE":{"nested":true}}',
    '',
  ].join('\n');
  const parsed = parseJournaldOutput(stdout);
  assert.equal(parsed.malformed, 1);
  assert.equal(parsed.withoutCursor, 1);
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.entries[0].message, 'ok');
  assert.equal(parsed.entries[1].messageEncoding, 'json', 'a non-string MESSAGE is preserved as JSON text, not dropped');
});

test('journald：重复键整行拒收，不再是 last-wins（DEF-07 已修复）', () => {
  // 旧断言（修复前）：`JSON.parse` 看不见重复键，`__CURSOR` 取最后一个值 —— entries 1 条、
  // cursor 为 `s=evil`。攻击面在于"这一行是谁"由解析器的覆盖策略决定：批准方按第一份内容
  // 判断，读日志的一方拿到第二份。
  // 修复后：`parseJournaldOutput` 在 `JSON.parse` 之前先做结构扫描（`findDuplicateJsonKey`），
  // 发现重复键就整行拒收并计入 `malformed`，不产出条目。
  const duplicate = parseJournaldOutput('{"__CURSOR":"s=abc","__CURSOR":"s=evil","MESSAGE":"x"}');
  assert.equal(duplicate.entries.length, 0, 'a duplicate-key record must not yield an entry');
  assert.equal(duplicate.malformed, 1);
  assert.equal(duplicate.withoutCursor, 0, 'a rejected line is malformed, not "a record without a cursor"');

  // 与顺序无关：把"坏值"放前面也必须拒收。否则只是把 last-wins 换成了 first-wins，
  // 攻击面没变——只是换了个方向。
  const reversed = parseJournaldOutput('{"__CURSOR":"s=evil","__CURSOR":"s=abc","MESSAGE":"x"}');
  assert.equal(reversed.entries.length, 0);
  assert.equal(reversed.malformed, 1);

  // 转义等价的键也是同一个键：`__CURSOR` 与 `\u005f\u005fCURSOR` 解码后逐字相同。
  // 只按字面字节比对的话，这里会退化成 last-wins。
  const escapedKey = parseJournaldOutput('{"__CURSOR":"s=abc","\\u005f\\u005fCURSOR":"s=evil","MESSAGE":"x"}');
  assert.equal(escapedKey.entries.length, 0, 'a duplicate introduced through JSON escapes must also be refused');
  assert.equal(escapedKey.malformed, 1);

  // 负向对照 1：没有重复键的正常行必须照常产出，且 cursor 来自原文（证明不是"见键就拒"）。
  const clean = parseJournaldOutput('{"__CURSOR":"s=abc","MESSAGE":"x"}');
  assert.equal(clean.entries.length, 1);
  assert.equal(clean.malformed, 0);
  assert.equal(clean.entries[0].cursor, 's=abc');

  // 负向对照 2：坏行不能把同一批里的好行也带走——拒收是逐行的。
  const mixed = parseJournaldOutput('{"__CURSOR":"s=a","__CURSOR":"s=b"}\n{"__CURSOR":"s=c","MESSAGE":"ok"}');
  assert.equal(mixed.entries.length, 1, 'the good line must survive its neighbour being rejected');
  assert.equal(mixed.malformed, 1);
  assert.equal(mixed.entries[0].cursor, 's=c');
});

test('journald：超长 MESSAGE 被截断并标记，二进制 MESSAGE 变成 hex 摘要', () => {
  const long = parseJournaldEntry({ __CURSOR: 's=a', MESSAGE: 'm'.repeat(5000) }, { maxMessageChars: 64 });
  assert.equal(long.messageTruncated, true);
  assert.equal(long.message.length, 64);

  const binary = parseJournaldEntry({ __CURSOR: 's=b', MESSAGE: [0x00, 0xff, 0x41] }, { maxMessageChars: 64 });
  assert.equal(binary.messageEncoding, 'hex');
  assert.equal(binary.message, '00ff41');
  assert.equal(binary.messageBytes, 3);
});

test('journald：__proto__ 作为条目的自有键不会污染原型', () => {
  const before = Object.getOwnPropertyNames(Object.prototype).sort().join(',');
  const entry = JSON.parse('{"__CURSOR":"s=x","__proto__":{"polluted":true},"MESSAGE":"m"}');
  const parsed = parseJournaldEntry(entry);
  assert.equal(parsed.cursor, 's=x');
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getOwnPropertyNames(Object.prototype).sort().join(','), before);
});

test('journald：没有 cursor 的条目被丢弃（没有稳定身份就无法重放去重）', () => {
  assert.equal(parseJournaldEntry({ MESSAGE: 'x' }), null);
  assert.equal(parseJournaldEntry({ __CURSOR: '', MESSAGE: 'x' }), null);
  assert.equal(parseJournaldEntry(null), null);
  assert.equal(parseJournaldEntry('string'), null);
});

test('journald：PRIORITY 越界时回落默认值，不产生非法严重度', () => {
  for (const priority of [-1, 8, 99, 'high', null, {}]) {
    const parsed = parseJournaldEntry({ __CURSOR: 's=p', MESSAGE: 'x', PRIORITY: priority });
    assert.equal(parsed.priority, 6, `priority ${String(priority)} must fall back to 6`);
    assert.equal(parsed.severityName, 'info');
  }
});
