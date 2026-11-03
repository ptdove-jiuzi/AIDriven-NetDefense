// author: PT-dove
// 确定性对抗语料表。
//
// 这里的每一条都是**字面量**或由固定种子生成的字符串：同一份代码在任何机器、任何
// 执行顺序下都产生完全相同的字节。没有 `Math.random()`、没有 `Date.now()`、
// 没有"取当前进程的 pid / 用户名 / 主机名"，因此不存在 flaky 的可能。
//
// 每条用例都有唯一 id，且每个表都由测试用 `for (const entry of TABLE)` 逐条展开成
// 独立用例——"写在表里"本身就等于"会被跑到"。`determinism.test.js` 另外断言 id 全局唯一、
// 每个表的条数不低于下限，防止有人删表时悄悄少掉覆盖。

/**
 * @typedef {{ id: string, group: string, note: string }} CorpusCase
 */

/** 严格 JSON：必须被拒绝的样本。`code` 是 `ERROR_CODES` 里的错误码。 */
export const STRICT_JSON_REJECTIONS = Object.freeze([
  // ---- 重复键 ----
  { id: 'json.dup.top', group: 'duplicate-key', code: 'ERR_DUPLICATE_KEY', json: '{"a":1,"a":2}', note: '重复键在 JSON.parse 里是静默 last-wins' },
  { id: 'json.dup.nested', group: 'duplicate-key', code: 'ERR_DUPLICATE_KEY', json: '{"a":{"b":1,"b":2}}', note: '嵌套重复键同样必须拒绝' },
  { id: 'json.dup.escaped-key', group: 'duplicate-key', code: 'ERR_DUPLICATE_KEY', json: '{"a":1,"\\u0061":2}', note: '转义写法解析后与 "a" 相同，属于同一键' },
  { id: 'json.dup.array-of-objects', group: 'duplicate-key', code: 'ERR_DUPLICATE_KEY', json: '[{"k":1,"k":1}]', note: '数组元素内部的重复键' },
  // ---- 深嵌套 ----
  { id: 'json.depth.7-objects', group: 'depth', code: 'ERR_MAX_DEPTH_EXCEEDED', json: '{"a":{"b":{"c":{"d":{"e":{"f":{"g":1}}}}}}}', note: 'maxDepth=6，第 7 层必须拒绝' },
  { id: 'json.depth.20000-arrays', group: 'depth', code: 'ERR_MAX_DEPTH_EXCEEDED', json: `${'['.repeat(20000)}${']'.repeat(20000)}`, note: '递归下降不能靠栈溢出兜底' },
  { id: 'json.depth.mixed', group: 'depth', code: 'ERR_MAX_DEPTH_EXCEEDED', json: '{"a":[{"b":[{"c":[{"d":1}]}]}]}', note: '对象与数组交替也要计入深度' },
  // ---- 超大数字 ----
  { id: 'json.number.2^53+1', group: 'number', code: 'ERR_NUMBER_PRECISION_LOSS', json: '{"a":9007199254740993}', note: 'JSON.parse 会静默截断成 9007199254740992' },
  { id: 'json.number.2^64', group: 'number', code: 'ERR_NUMBER_PRECISION_LOSS', json: '{"a":18446744073709551616}', note: '超出安全整数范围' },
  { id: 'json.number.400-digits', group: 'number', code: 'ERR_NUMBER_PRECISION_LOSS', json: `{"a":${'9'.repeat(400)}}`, note: '超长整数 token' },
  { id: 'json.number.1e309', group: 'number', code: 'ERR_NUMBER_NOT_FINITE', json: '{"a":1e309}', note: '上溢成 Infinity' },
  { id: 'json.number.-1e309', group: 'number', code: 'ERR_NUMBER_NOT_FINITE', json: '{"a":-1e309}', note: '负向上溢' },
  { id: 'json.number.1e999999', group: 'number', code: 'ERR_NUMBER_NOT_FINITE', json: '{"a":1e999999}', note: '极端指数' },
  { id: 'json.number.leading-zero', group: 'number', code: 'ERR_JSON_SYNTAX', json: '{"a":01}', note: 'RFC 8259 禁止前导零' },
  { id: 'json.number.trailing-dot', group: 'number', code: 'ERR_JSON_SYNTAX', json: '{"a":1.}', note: '小数点后必须有数字' },
  { id: 'json.number.leading-dot', group: 'number', code: 'ERR_JSON_SYNTAX', json: '{"a":.5}', note: '整数部分不能省略' },
  { id: 'json.number.plus', group: 'number', code: 'ERR_JSON_SYNTAX', json: '{"a":+1}', note: '不允许前导正号' },
  { id: 'json.number.hex', group: 'number', code: 'ERR_JSON_SYNTAX', json: '{"a":0x10}', note: 'JSON 没有十六进制字面量' },
  { id: 'json.number.nan', group: 'number', code: 'ERR_JSON_SYNTAX', json: '{"a":NaN}', note: 'NaN 不是 JSON' },
  { id: 'json.number.infinity', group: 'number', code: 'ERR_JSON_SYNTAX', json: '{"a":Infinity}', note: 'Infinity 不是 JSON' },
  // ---- 孤立代理项 ----
  { id: 'json.surrogate.lone-high', group: 'surrogate', code: 'ERR_UNPAIRED_SURROGATE', json: '{"a":"\\ud800"}', note: '孤立高代理项' },
  { id: 'json.surrogate.lone-low', group: 'surrogate', code: 'ERR_UNPAIRED_SURROGATE', json: '{"a":"\\udc00"}', note: '孤立低代理项' },
  { id: 'json.surrogate.high-then-bmp', group: 'surrogate', code: 'ERR_UNPAIRED_SURROGATE', json: '{"a":"\\ud800\\u0041"}', note: '高代理项后面不是低代理项' },
  { id: 'json.surrogate.reversed-pair', group: 'surrogate', code: 'ERR_UNPAIRED_SURROGATE', json: '{"a":"\\udc00\\ud800"}', note: '顺序颠倒的代理对' },
  { id: 'json.surrogate.raw-lone', group: 'surrogate', code: 'ERR_UNPAIRED_SURROGATE', json: `{"a":"x${String.fromCharCode(0xd800)}y"}`, note: '原文里的裸代理项（不是转义）' },
  { id: 'json.surrogate.key', group: 'surrogate', code: 'ERR_UNPAIRED_SURROGATE', json: '{"\\ud800":1}', note: '键名里的孤立代理项' },
  // ---- 控制字符 / 双向符 / 零宽 ----
  { id: 'json.control.nul', group: 'control', code: 'ERR_STRING_CONTROL_CHARACTER', json: '{"a":"x\\u0000y"}', note: 'NUL' },
  { id: 'json.control.esc', group: 'control', code: 'ERR_STRING_CONTROL_CHARACTER', json: '{"a":"\\u001b[31mred\\u001b[0m"}', note: 'ANSI 转义序列（终端注入）' },
  { id: 'json.control.tab', group: 'control', code: 'ERR_STRING_CONTROL_CHARACTER', json: '{"a":"x\\ty"}', note: '制表符默认也不放行' },
  { id: 'json.control.del', group: 'control', code: 'ERR_STRING_CONTROL_CHARACTER', json: '{"a":"x\\u007fy"}', note: 'DEL(0x7F)' },
  { id: 'json.control.c1', group: 'control', code: 'ERR_STRING_CONTROL_CHARACTER', json: '{"a":"x\\u0085y"}', note: 'C1 控制符' },
  { id: 'json.control.raw-nul', group: 'control', code: 'ERR_STRING_CONTROL_CHARACTER', json: `{"a":"x${String.fromCharCode(0)}y"}`, note: '原文里的裸 NUL' },
  { id: 'json.bidi.rlo', group: 'control', code: 'ERR_STRING_BIDI_OVERRIDE', json: '{"a":"\\u202egnp.exe"}', note: '双向覆盖可伪装扩展名' },
  { id: 'json.bidi.isolate', group: 'control', code: 'ERR_STRING_BIDI_OVERRIDE', json: '{"a":"\\u2066x\\u2069"}', note: '双向隔离符' },
  { id: 'json.zerowidth.zwsp', group: 'control', code: 'ERR_STRING_ZERO_WIDTH', json: '{"a":"\\u200bx"}', note: '零宽空格' },
  { id: 'json.zerowidth.bom', group: 'control', code: 'ERR_STRING_ZERO_WIDTH', json: '{"a":"\\ufeffx"}', note: '字符串中间的 BOM' },
  { id: 'json.nfc.nfd', group: 'control', code: 'ERR_STRING_NOT_NFC', json: '{"a":"a\\u0301"}', note: 'NFD 与 NFC 字节不同但显示相同' },
  { id: 'json.nfc.combining-key', group: 'control', code: 'ERR_STRING_NOT_NFC', json: '{"e\\u0301":1}', note: '组合字符构成的非 NFC 键名' },
  // ---- 编码 ----
  { id: 'json.encoding.bom-prefix', group: 'encoding', code: 'ERR_ENCODING_NOT_UTF8', json: '\ufeff{"a":1}', note: 'UTF-8 BOM 必须显式拒绝而不是静默剥掉' },
  // ---- 结构上限 ----
  { id: 'json.limit.keys-129', group: 'limit', code: 'ERR_MAX_OBJECT_KEYS', json: `{${Array.from({ length: 129 }, (_, i) => `"k${i}":1`).join(',')}}`, note: 'maxObjectKeys=128' },
  { id: 'json.limit.array-257', group: 'limit', code: 'ERR_MAX_ARRAY_ITEMS', json: `[${Array.from({ length: 257 }, () => '1').join(',')}]`, note: 'maxArrayItems=256' },
  { id: 'json.limit.string-20000', group: 'limit', code: 'ERR_MAX_STRING_BYTES', json: `{"a":"${'x'.repeat(20000)}"}`, note: 'maxStringBytes=16384' },
  // ---- 语法 ----
  { id: 'json.syntax.trailing', group: 'syntax', code: 'ERR_JSON_SYNTAX', json: '{"a":1}{"b":2}', note: '多值拼接（请求走私的经典形态）' },
  { id: 'json.syntax.trailing-garbage', group: 'syntax', code: 'ERR_JSON_SYNTAX', json: '{"a":1}x', note: '值后面的垃圾字符' },
  { id: 'json.syntax.empty', group: 'syntax', code: 'ERR_JSON_SYNTAX', json: '', note: '空输入' },
  { id: 'json.syntax.array-trailing-comma', group: 'syntax', code: 'ERR_JSON_SYNTAX', json: '[1,]', note: '尾逗号' },
  { id: 'json.syntax.object-trailing-comma', group: 'syntax', code: 'ERR_JSON_SYNTAX', json: '{"a":1,}', note: '对象尾逗号' },
  { id: 'json.syntax.comment', group: 'syntax', code: 'ERR_JSON_SYNTAX', json: '{"a":1}//c', note: '注释不是 JSON' },
  { id: 'json.syntax.unterminated-string', group: 'syntax', code: 'ERR_JSON_SYNTAX', json: '{"a":"x}', note: '未闭合字符串' },
  { id: 'json.syntax.bad-escape', group: 'syntax', code: 'ERR_JSON_SYNTAX', json: '{"a":"\\q"}', note: '非法转义' },
  { id: 'json.syntax.short-unicode', group: 'syntax', code: 'ERR_JSON_SYNTAX', json: '{"a":"\\u12"}', note: '\\u 后面不足 4 位十六进制' },
  { id: 'json.syntax.single-quote', group: 'syntax', code: 'ERR_JSON_SYNTAX', json: "{'a':1}", note: '单引号不是 JSON' },
  { id: 'json.syntax.key-not-string', group: 'syntax', code: 'ERR_JSON_SYNTAX', json: '{1:2}', note: '键必须是字符串' },
  // ---- 危险键 ----
  { id: 'json.proto.top', group: 'forbidden-key', code: 'ERR_FORBIDDEN_KEY', json: '{"__proto__":{"polluted":true}}', note: '原型污染' },
  { id: 'json.proto.nested', group: 'forbidden-key', code: 'ERR_FORBIDDEN_KEY', json: '{"a":{"__proto__":{"polluted":true}}}', note: '任意深度都要拒绝' },
  { id: 'json.proto.constructor', group: 'forbidden-key', code: 'ERR_FORBIDDEN_KEY', json: '{"constructor":{"prototype":{"x":1}}}', note: 'constructor.prototype 链' },
  { id: 'json.proto.prototype', group: 'forbidden-key', code: 'ERR_FORBIDDEN_KEY', json: '{"prototype":{"x":1}}', note: 'prototype 键' },
]);

/**
 * 严格 JSON：必须被**接受**的样本。
 *
 * 这些用例的作用是防止"一律拒绝"式的假安全：把合法输入也拒掉同样会让检测失效。
 */
export const STRICT_JSON_ACCEPTANCES = Object.freeze([
  { id: 'json.ok.scalars', group: 'accept', json: '{"a":true,"b":false,"c":null}', expect: { a: true, b: false, c: null } },
  { id: 'json.ok.depth-6', group: 'accept', json: '{"a":{"b":{"c":{"d":{"e":{"f":1}}}}}}', expect: { a: { b: { c: { d: { e: { f: 1 } } } } } } },
  { id: 'json.ok.max-safe-int', group: 'accept', json: '{"a":9007199254740991}', expect: { a: 9007199254740991 } },
  { id: 'json.ok.min-safe-int', group: 'accept', json: '{"a":-9007199254740991}', expect: { a: -9007199254740991 } },
  { id: 'json.ok.negative-zero', group: 'accept', json: '{"a":-0}', expect: { a: 0 } },
  { id: 'json.ok.surrogate-pair', group: 'accept', json: '{"a":"\\ud83d\\ude00"}', expect: { a: '\u{1F600}' } },
  { id: 'json.ok.case-distinct-keys', group: 'accept', json: '{"a":1,"A":2}', expect: { a: 1, A: 2 } },
  { id: 'json.ok.cjk', group: 'accept', json: '{"a":"可疑进程"}', expect: { a: '可疑进程' } },
  { id: 'json.ok.u2028', group: 'accept', json: '{"a":"x\\u2028y"}', expect: { a: 'x\u2028y' } },
  { id: 'json.ok.escaped-solidus', group: 'accept', json: '{"a":"x\\/y"}', expect: { a: 'x/y' } },
  { id: 'json.ok.empty-object', group: 'accept', json: '{}', expect: {} },
  { id: 'json.ok.empty-array', group: 'accept', json: '[]', expect: [] },
]);

/**
 * contracts payload 负向语料：`validateTelemetryEvent` 必须拒绝。
 *
 * `payload` 直接构造（不经 JSON 文本），覆盖"进程内调用方传对象"的路径。
 */
export const PAYLOAD_REJECTIONS = Object.freeze([
  { id: 'payload.key.camel', group: 'key', code: 'ERR_FIELD_PATTERN', payload: { imagePath: 'C:/x.exe' }, note: 'payload 键必须是 snake_case' },
  { id: 'payload.key.proto', group: 'key', code: 'ERR_FIELD_PATTERN', payload: JSON.parse('{"__proto__":{"polluted":true}}'), note: '原型污染键' },
  { id: 'payload.key.uppercase', group: 'key', code: 'ERR_FIELD_PATTERN', payload: { PID: 1 }, note: '大写键' },
  { id: 'payload.key.empty', group: 'key', code: 'ERR_FIELD_PATTERN', payload: { '': 1 }, note: '空键' },
  { id: 'payload.key.too-long', group: 'key', code: 'ERR_FIELD_PATTERN', payload: { [`a${'b'.repeat(64)}`]: 1 }, note: '键长上限 64' },
  { id: 'payload.key.dot', group: 'key', code: 'ERR_FIELD_PATTERN', payload: { 'a.b': 1 }, note: '键里不能有点（避免与字段路径混淆）' },
  { id: 'payload.value.control', group: 'value', code: 'ERR_STRING_CONTROL_CHARACTER', payload: { cmd: 'x\u0007y' }, note: 'BEL' },
  { id: 'payload.value.ansi', group: 'value', code: 'ERR_STRING_CONTROL_CHARACTER', payload: { cmd: '\u001b[2J' }, note: 'ANSI 清屏' },
  { id: 'payload.value.newline', group: 'value', code: 'ERR_STRING_CONTROL_CHARACTER', payload: { cmd: 'a\nb' }, note: '多行文本必须走 raw_evidence 通道' },
  { id: 'payload.value.bidi', group: 'value', code: 'ERR_STRING_BIDI_OVERRIDE', payload: { name: '\u202egnp.exe' }, note: '双向覆盖伪装' },
  { id: 'payload.value.zerowidth', group: 'value', code: 'ERR_STRING_ZERO_WIDTH', payload: { name: 'a\u200bb' }, note: '零宽字符' },
  { id: 'payload.value.lone-surrogate', group: 'value', code: 'ERR_UNPAIRED_SURROGATE', payload: { name: `a${String.fromCharCode(0xdc00)}b` }, note: '孤立代理项' },
  { id: 'payload.value.nested-object', group: 'value', code: 'ERR_FIELD_TYPE', payload: { a: { b: 1 } }, note: 'payload 值只能是标量或同类型标量数组' },
  { id: 'payload.value.nan', group: 'value', code: 'ERR_NUMBER_PRECISION_LOSS', payload: { ratio: Number.NaN }, note: 'NaN 不是安全整数' },
  { id: 'payload.value.infinity', group: 'value', code: 'ERR_NUMBER_PRECISION_LOSS', payload: { ratio: Number.POSITIVE_INFINITY }, note: 'Infinity 不是安全整数' },
  { id: 'payload.value.float', group: 'value', code: 'ERR_NUMBER_PRECISION_LOSS', payload: { ratio: 0.5 }, note: 'payload 只接受安全整数' },
  { id: 'payload.value.unsafe-int', group: 'value', code: 'ERR_NUMBER_PRECISION_LOSS', payload: { pid: 9007199254740993 }, note: '超出安全整数' },
  { id: 'payload.value.mixed-array', group: 'value', code: 'ERR_FIELD_TYPE', payload: { list: [1, 'a'] }, note: '数组元素类型必须一致' },
  { id: 'payload.value.array-of-objects', group: 'value', code: 'ERR_FIELD_TYPE', payload: { list: [{ a: 1 }] }, note: '数组元素不能是对象' },
  { id: 'payload.value.too-many-keys', group: 'limit', code: 'ERR_MAX_OBJECT_KEYS', payload: Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`k${i}`, 1])), note: 'payload 键数上限' },
  { id: 'payload.value.too-many-items', group: 'limit', code: 'ERR_MAX_ARRAY_ITEMS', payload: { list: Array.from({ length: 257 }, () => 1) }, note: 'payload 数组上限' },
  { id: 'payload.value.too-large', group: 'limit', code: 'ERR_MAX_STRING_BYTES', payload: { blob: 'x'.repeat(20000) }, note: '单字符串上限 16KiB' },
  { id: 'payload.raw-evidence.bad-encoding', group: 'raw', code: 'ERR_FIELD_ENUM', payload: { raw_evidence: { encoding: 'utf-16', text: 'x' } }, note: 'raw_evidence.encoding 只能是 utf-8' },
  { id: 'payload.raw-evidence.esc', group: 'raw', code: 'ERR_STRING_CONTROL_CHARACTER', payload: { raw_evidence: { encoding: 'utf-8', text: 'x\u001by' } }, note: 'raw_evidence 只放行 \\t \\n \\r，不放行 ESC' },
  { id: 'payload.raw-evidence.missing-text', group: 'raw', code: 'ERR_MISSING_FIELD', payload: { raw_evidence: { encoding: 'utf-8' } }, note: 'raw_evidence.text 必填' },
]);

/**
 * 严格 JSON 选项加固：调用方不能把全局硬上限放宽。
 */
export const STRICT_JSON_OPTION_ATTEMPTS = Object.freeze([
  { id: 'option.depth-99', group: 'option', options: { maxDepth: 99 }, json: '{"a":{"b":{"c":{"d":{"e":{"f":{"g":1}}}}}}}', note: 'maxDepth 只能收紧' },
  { id: 'option.message-4mb', group: 'option', options: { maxMessageBytes: 4000000 }, json: `{"a":"${'x'.repeat(2000000)}"}`, note: 'maxMessageBytes 只能收紧' },
  { id: 'option.string-1mb', group: 'option', options: { maxStringBytes: 1048576 }, json: `{"a":"${'x'.repeat(300000)}"}`, note: 'maxStringBytes 天花板是 maxRawEvidenceStringBytes' },
  { id: 'option.keys-1000', group: 'option', options: { maxObjectKeys: 1000 }, json: `{${Array.from({ length: 200 }, (_, i) => `"k${i}":1`).join(',')}}`, note: 'maxObjectKeys 只能收紧' },
  { id: 'option.items-10000', group: 'option', options: { maxArrayItems: 10000 }, json: `[${Array.from({ length: 300 }, () => '1').join(',')}]`, note: 'maxArrayItems 只能收紧' },
  { id: 'option.allow-controls-true', group: 'option', options: { allowControls: true }, json: '{"a":"x\\u001by"}', note: 'allowControls:true 只等于 \\t\\n\\r，不等于放行 ESC' },
  { id: 'option.allow-controls-array-esc', group: 'option', options: { allowControls: ['\u001b'] }, json: '{"a":"x\\u001by"}', note: '数组形式也只能从 RAW_EVIDENCE_CONTROLS 取交集' },
]);

/**
 * Windows 采集器：payload 键必须被拒绝（编程错误，必须显式抛）。
 */
export const WINDOWS_PAYLOAD_BAD_KEYS = Object.freeze([
  { id: 'win.key.camel', key: 'imagePath', note: '真实 Windows 字段名是 camelCase' },
  { id: 'win.key.record-id', key: 'recordId', note: '同上' },
  { id: 'win.key.uppercase', key: 'Pid', note: '大写开头' },
  { id: 'win.key.proto', key: '__proto__', note: '原型污染（键名规则先于赋值拦截）' },
  { id: 'win.key.digit-start', key: '1pid', note: '不能以数字开头' },
  { id: 'win.key.hyphen', key: 'process-name', note: '不能有连字符' },
  { id: 'win.key.too-long', key: `a${'b'.repeat(64)}`, note: '长度上限 64' },
  { id: 'win.key.empty', key: '', note: '空键' },
]);

/**
 * Windows 采集器：值必须被**清洗或丢弃**而不是让整批失败。
 */
export const WINDOWS_PAYLOAD_SANITIZE_CASES = Object.freeze([
  { id: 'win.value.ansi', key: 'message', value: '\u001b[31mFailed\u001b[0m', mustNotContain: '\u001b', note: 'ANSI 必须被剥掉' },
  { id: 'win.value.nul', key: 'message', value: 'a\u0000b', mustNotContain: '\u0000', note: 'NUL 必须被剥掉' },
  { id: 'win.value.multiline', key: 'message', value: 'line1\r\nline2\tline3', mustNotContain: '\r', note: '\\r\\n\\t 折叠成空格' },
  { id: 'win.value.bidi', key: 'message', value: 'gnp\u202eexe', mustNotContain: '\u202e', note: '双向覆盖必须被剥掉' },
  { id: 'win.value.zerowidth', key: 'message', value: 'a\u200bb', mustNotContain: '\u200b', note: '零宽字符必须被剥掉' },
  { id: 'win.value.lone-surrogate', key: 'message', value: `a${String.fromCharCode(0xd800)}b`, mustNotContain: String.fromCharCode(0xd800), note: '孤立代理项替换成 U+FFFD' },
  { id: 'win.value.nfd', key: 'message', value: 'e\u0301', mustNotContain: 'e\u0301', note: '必须归一化为 NFC' },
]);

/**
 * Linux auth-log：真实日志里会出现的恶意/畸形行。
 *
 * `rejectCode` 表示"把这一行的 payload 键改成 snake_case 之后，contracts 仍会拒绝"
 * 的错误码；`null` 表示这一行的载荷本身是合法文本（注入只体现在内容与记录边界上）。
 * 两者都是语料记录的真实缺陷证据（见状态文件 DEF-03 / DEF-04）。
 */
export const AUTH_LOG_LINE_CASES = Object.freeze([
  {
    id: 'linux.line.ansi',
    group: 'control',
    line: 'Oct 31 10:00:01 lab-host.example.test sshd[812]: \u001b[31mFailed password\u001b[0m for root',
    note: 'ANSI 转义序列',
    rejectCode: 'ERR_STRING_CONTROL_CHARACTER',
  },
  {
    id: 'linux.line.nul',
    group: 'control',
    line: `Oct 31 10:00:02 lab-host.example.test sshd[812]: Failed password\u0000for root`,
    note: 'NUL 截断（日志注入常用手法）',
    rejectCode: 'ERR_STRING_CONTROL_CHARACTER',
  },
  {
    id: 'linux.line.crlf',
    group: 'control',
    line: 'Oct 31 10:00:03 lab-host.example.test sshd[812]: Failed password\r',
    note: 'CRLF 日志（\\r 会留在行尾）',
    rejectCode: 'ERR_STRING_CONTROL_CHARACTER',
  },
  {
    id: 'linux.line.fake-record',
    group: 'injection',
    line: 'Oct 31 10:00:04 lab-host.example.test sshd[812]: Accepted publickey for admin\nOct 31 10:00:05 evil sshd[1]: Failed password',
    note: '行内伪造第二条记录（换行就是记录边界，会多出一条独立记录）',
    rejectCode: null,
  },
  {
    id: 'linux.line.shell',
    group: 'injection',
    line: 'Oct 31 10:00:06 lab-host.example.test sshd[812]: Failed password for $(reboot) `id` ; rm -rf /',
    note: 'shell 元字符必须只当文本',
    rejectCode: null,
  },
  {
    id: 'linux.line.json-injection',
    group: 'injection',
    line: 'Oct 31 10:00:07 lab-host.example.test sshd[812]: {"severity":"critical","rule_id":"forged"}',
    note: '看起来像 JSON 的载荷不能改变事件结构',
    rejectCode: null,
  },
  {
    id: 'linux.line.bidi',
    group: 'control',
    line: 'Oct 31 10:00:08 lab-host.example.test sshd[812]: \u202egnp.exe failed',
    note: '双向覆盖',
    rejectCode: 'ERR_STRING_BIDI_OVERRIDE',
  },
  {
    id: 'linux.line.long',
    group: 'limit',
    line: `Oct 31 10:00:09 lab-host.example.test sshd[812]: ${'A'.repeat(5000)}`,
    note: '超长行必须按 maxLineChars 截断并标记',
    rejectCode: null,
  },
]);

/**
 * 插件源码词法样本：`scanModuleSource` 的期望诊断。
 *
 * `expectCode` 为 `null` 表示"必须**不**报这个错"（用于证明扫描器不是见词就报）。
 */
export const LEXICAL_SOURCE_CASES = Object.freeze([
  { id: 'lex.escaped-identifier', source: 'const p = \\u0070rocess;\nexport function apply() {}\n', expectCode: 'INVALID_VALUE', note: '标识符转义可以隐藏 process' },
  { id: 'lex.process-direct', source: 'export function apply() { process.exit(1); }\n', expectCode: 'UNSUPPORTED_API', note: '直接引用 process' },
  { id: 'lex.process-in-string', source: 'export function apply() { return "process.exit"; }\n', expectCode: null, note: '字符串里的词不是代码' },
  { id: 'lex.process-in-comment', source: '// process.exit(1)\nexport function apply() {}\n', expectCode: null, note: '注释里的词不是代码' },
  { id: 'lex.process-as-property-key', source: 'export function apply() { const o = { process: 1 }; return o.process; }\n', expectCode: null, note: '属性名不是全局引用' },
  { id: 'lex.process-as-member', source: 'export function apply(x) { return x.process; }\n', expectCode: null, note: '成员访问不是全局引用' },
  { id: 'lex.eval-direct', source: 'export function apply() { eval("1+1"); }\n', expectCode: 'UNSUPPORTED_API', note: 'eval' },
  { id: 'lex.function-ctor', source: 'export function apply() { return Function("return 1"); }\n', expectCode: 'UNSUPPORTED_API', note: 'Function 构造器' },
  { id: 'lex.globalThis-process', source: 'export function apply() { globalThis.process.exit(1); }\n', expectCode: 'UNSUPPORTED_API', note: 'globalThis.process' },
  { id: 'lex.globalThis-bracket', source: 'export function apply() { globalThis["process"].exit(1); }\n', expectCode: 'UNSUPPORTED_API', note: 'globalThis["process"]' },
  { id: 'lex.globalThis-concat', source: 'export function apply() { globalThis["pro" + "cess"].exit(1); }\n', expectCode: null, note: '★ 词法绕过：拼接后不再是字面量（DEF-05）' },
  { id: 'lex.import-meta-resolve', source: 'export function apply() { return import.meta.resolve("node:fs"); }\n', expectCode: 'UNSUPPORTED_API', note: 'import.meta.resolve' },
  { id: 'lex.import-meta-bracket', source: 'export function apply() { return import.meta["resolve"]("node:fs"); }\n', expectCode: null, note: '★ 词法绕过：方括号成员（DEF-05）' },
  { id: 'lex.require', source: 'export function apply() { require("node:fs"); }\n', expectCode: 'UNSUPPORTED_API', note: 'CommonJS require' },
  { id: 'lex.module-exports', source: 'export function apply() { module.exports = {}; }\n', expectCode: 'UNSUPPORTED_API', note: 'module.exports' },
  { id: 'lex.export-default', source: 'export default function apply() {}\n', expectCode: 'UNSUPPORTED_API', note: 'export default 不在允许的导出面里' },
  { id: 'lex.export-star', source: 'export * from "./other.js";\nexport function apply() {}\n', expectCode: 'UNSUPPORTED_API', note: 'export * 无法静态核对导出面' },
  { id: 'lex.export-alias-default', source: 'function apply() {}\nexport { apply as default };\n', expectCode: 'EXPORT_SHAPE_INVALID', note: '别名成 default 同样不允许' },
  { id: 'lex.export-unknown-name', source: 'export function apply() {}\nexport const helper = 1;\n', expectCode: 'EXPORT_SHAPE_INVALID', note: '入口只能导出 apply/dispose/inject' },
  { id: 'lex.dynamic-import-literal', source: 'export async function apply() { await import("./helper.js"); }\n', expectCode: null, note: '字面量动态导入是允许的' },
  { id: 'lex.dynamic-import-concat', source: 'export async function apply() { await import("./" + "helper.js"); }\n', expectCode: 'UNSUPPORTED_API', note: '非字面量动态导入无法静态核对' },
  { id: 'lex.dynamic-import-template', source: 'export async function apply() { const n = "x"; await import(`./${n}.js`); }\n', expectCode: 'UNSUPPORTED_API', note: '带插值的模板不是字面量' },
  { id: 'lex.import-node-fs', source: 'import fs from "node:fs";\nexport function apply() {}\n', expectCode: 'UNSUPPORTED_API', note: 'Node 内置模块' },
  { id: 'lex.import-bare', source: 'import lodash from "lodash";\nexport function apply() {}\n', expectCode: 'UNSUPPORTED_API', note: '裸包名' },
  { id: 'lex.import-url', source: 'import x from "https://evil.example/x.js";\nexport function apply() {}\n', expectCode: 'UNSUPPORTED_API', note: '远程 URL' },
  { id: 'lex.import-escape', source: 'import x from "../../outside.js";\nexport function apply() {}\n', expectCode: 'ENTRY_ESCAPE', note: '相对导入逃出包根' },
  { id: 'lex.import-without-extension', source: 'import x from "./helper";\nexport function apply() {}\n', expectCode: 'UNSUPPORTED_API', note: '相对导入必须是 .js' },
  { id: 'lex.inject-unknown', source: 'export const inject = ["aegisShell"];\nexport function apply() {}\n', expectCode: 'UNSUPPORTED_API', note: 'inject 只允许四个名字' },
  { id: 'lex.inject-not-literal', source: 'const names = ["aegisLogger"];\nexport const inject = names;\nexport function apply() {}\n', expectCode: 'UNSUPPORTED_API', note: 'inject 必须是字面量数组' },
  { id: 'lex.unterminated-string', source: 'export function apply() { const s = "abc; }\n', expectCode: 'INVALID_VALUE', note: '未闭合字符串不能让扫描器崩溃' },
  { id: 'lex.unterminated-template', source: 'export function apply() { const s = `abc; }\n', expectCode: 'INVALID_VALUE', note: '未闭合模板' },
  { id: 'lex.unterminated-comment', source: 'export function apply() {}\n/* never closed\n', expectCode: 'INVALID_VALUE', note: '未闭合块注释' },
  { id: 'lex.regex-after-return', source: 'export function apply(x) { return /\\d+/.test(x); }\n', expectCode: null, note: 'return 后的 / 是正则而不是除法' },
  { id: 'lex.division', source: 'export function apply(a, b) { return a / b / 2; }\n', expectCode: null, note: '除号不能被当成正则起点' },
  { id: 'lex.worker', source: 'export function apply() { new Worker("x"); }\n', expectCode: 'UNSUPPORTED_API', note: 'Worker' },
  { id: 'lex.shared-array-buffer', source: 'export function apply() { return new SharedArrayBuffer(8); }\n', expectCode: 'UNSUPPORTED_API', note: '共享内存' },
  { id: 'lex.atomics', source: 'export function apply() { return Atomics.load; }\n', expectCode: 'UNSUPPORTED_API', note: 'Atomics' },
]);

/**
 * 插件入口路径的**词法/路径**绕过样本：`assertSafeRelativePath` 必须拒绝。
 */
export const UNSAFE_ENTRY_PATHS = Object.freeze([
  { id: 'entry.traversal', path: '../lib/index.js', note: '父目录' },
  { id: 'entry.traversal-nested', path: 'lib/../../index.js', note: '嵌套父目录' },
  { id: 'entry.absolute-posix', path: '/etc/passwd.js', note: 'POSIX 绝对路径' },
  { id: 'entry.drive-letter', path: 'C:/windows/system32/x.js', note: '盘符路径' },
  { id: 'entry.unc', path: '\\\\server\\share\\x.js', note: 'UNC 路径' },
  { id: 'entry.backslash', path: 'lib\\index.js', note: '反斜杠（Windows 分隔符）' },
  { id: 'entry.percent', path: 'lib/%2e%2e/index.js', note: '百分号编码的穿越' },
  { id: 'entry.trailing-slash', path: 'lib/index.js/', note: '以分隔符结尾' },
  { id: 'entry.double-slash', path: 'lib//index.js', note: '空路径段' },
  { id: 'entry.dot-segment', path: './lib/index.js', note: '当前目录段' },
  { id: 'entry.trailing-space', path: 'lib/index.js ', note: 'Windows 会静默去掉尾随空格' },
  { id: 'entry.trailing-dot', path: 'lib/index.js.', note: 'Windows 会静默去掉尾随点' },
  { id: 'entry.device-name', path: 'con.js', note: '保留设备名' },
  { id: 'entry.device-name-nested', path: 'lib/nul.js', note: '嵌套保留设备名' },
  { id: 'entry.device-name-extension', path: 'lib/com1.txt.js', note: 'COM1.txt 仍然是设备' },
  { id: 'entry.control-char', path: 'lib/in\u0000dex.js', note: 'NUL 截断' },
  { id: 'entry.not-js', path: 'lib/index.mjs', note: '只允许 .js' },
  { id: 'entry.empty', path: '', note: '空路径' },
  { id: 'entry.too-long', path: `${'a'.repeat(513)}.js`, note: '长度上限 512' },
]);

/**
 * 插件 id 的伪造样本：`validatePluginJson` 必须拒绝。
 */
export const INVALID_PLUGIN_IDS = Object.freeze([
  { id: 'plugin-id.uppercase', value: 'Com.Example.Notes', note: '必须全小写' },
  { id: 'plugin-id.single-label', value: 'notes', note: '必须是反向 DNS' },
  { id: 'plugin-id.reserved-aegis', value: 'aegis.core', note: '保留前缀' },
  { id: 'plugin-id.reserved-core', value: 'core.engine', note: '保留前缀' },
  { id: 'plugin-id.reserved-builtin', value: 'builtin.tools', note: '保留前缀' },
  { id: 'plugin-id.reserved-dsh', value: 'dsh.profile', note: '保留前缀' },
  { id: 'plugin-id.leading-dash', value: 'com.-example.notes', note: '标签不能以连字符开头' },
  { id: 'plugin-id.trailing-dash', value: 'com.example-.notes', note: '标签不能以连字符结尾' },
  { id: 'plugin-id.unicode-homoglyph', value: 'com.ex\u0430mple.notes', note: '西里尔 а 与拉丁 a 同形' },
  { id: 'plugin-id.underscore', value: 'com.example.my_plugin', note: '下划线不在字符集里' },
  { id: 'plugin-id.space', value: 'com.example.my plugin', note: '空格' },
  { id: 'plugin-id.trailing-dot', value: 'com.example.notes.', note: '尾随点' },
  { id: 'plugin-id.too-long', value: `com.${'a'.repeat(126)}`, note: '长度上限 128' },
]);
