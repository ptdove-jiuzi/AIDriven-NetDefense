/**
 * json-guard.js — 重复键检测（DEF-07）。
 *
 * 为什么需要它：`JSON.parse` 看不见重复键，`{"a":1,"a":2}` 会被静默解释成 `{a:2}`
 * （last-wins）。contracts 的 `parseStrictJson` 与 plugin-manager 的解析器都会报
 * `DUPLICATE_KEY`，而 journald / PowerShell 这两处输出解析用的是 `JSON.parse`——
 * 同一份 JSON 文本在不同组件里得到不同解释，违背 AT-IPC-002 的"各组件消费同一规范化结果"。
 *
 * 为什么不直接把 `parseStrictJson` 搬过来：journald 的 `MESSAGE` 是**日志原文**，
 * 合法地带有 ESC / 控制符（payload 阶段才清洗）。`parseStrictJson` 会因此整条拒收，
 * 那正好是 DEF-03 记录的攻击面——能写日志的一方用一行带 ESC 的文本让自己的记录消失。
 * 所以这里只复用**重复键这一条规则**，不引入严格解析器其余的限制：
 * 语法是否合法仍然交给 `JSON.parse`，本模块只回答"这段文本里有没有重复键"。
 *
 * 两条规则的一致性由 `tests/wp2-linux/json-guard.test.js` 用同一张样本表交叉验证
 * （本模块报重复的样本，`parseStrictJson` 必须也报 `ERR_DUPLICATE_KEY`）。
 */

const SIMPLE_ESCAPES = new Map([
  ['"', '"'],
  ['\\', '\\'],
  ['/', '/'],
  ['b', '\b'],
  ['f', '\f'],
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
]);

const HEX4 = /^[0-9a-fA-F]{4}$/u;

/**
 * 读一个字符串字面量，`start` 指向开引号。
 *
 * 转义按 JSON 规则解码，因此 `"a"` 与 `"\u0061"` 会被认成同一个键——
 * 这正是"转义等价键"必须撞上的地方。
 *
 * @param {string} text 文本。
 * @param {number} start 开引号下标。
 * @returns {{value: string, end: number} | null} 解码结果与结束下标；文本不合法时返回 `null`。
 */
function readString(text, start) {
  const total = text.length;
  let index = start + 1;
  let out = '';
  let segmentStart = index;
  for (;;) {
    if (index >= total) {
      return null;
    }
    const code = text.charCodeAt(index);
    if (code === 0x22) {
      return { value: out + text.slice(segmentStart, index), end: index + 1 };
    }
    if (code === 0x5c) {
      out += text.slice(segmentStart, index);
      index += 1;
      if (index >= total) {
        return null;
      }
      const marker = text[index];
      if (marker === 'u') {
        const hex = text.slice(index + 1, index + 5);
        if (!HEX4.test(hex)) {
          return null;
        }
        out += String.fromCharCode(Number.parseInt(hex, 16));
        index += 5;
      } else {
        const mapped = SIMPLE_ESCAPES.get(marker);
        if (mapped === undefined) {
          return null;
        }
        out += mapped;
        index += 1;
      }
      segmentStart = index;
      continue;
    }
    index += 1;
  }
}

/**
 * 在一个对象上下文的键集合里登记键名。
 *
 * @param {{keys: Set<string>, path: string}} context 对象上下文。
 * @param {string} key 解码后的键名。
 * @returns {{key: string, path: string} | null} 重复时返回该键及其路径。
 */
function registerKey(context, key) {
  if (context.keys.has(key)) {
    return { key, path: `${context.path}.${key}` };
  }
  context.keys.add(key);
  return null;
}

/**
 * 扫描 JSON 文本，返回第一个重复出现的对象键。
 *
 * 只做结构扫描，不做求值：不构造值、不检查数字与字面量是否合法、不限制深度。
 * 文本本身不合法（未闭合字符串、非法转义）时返回 `null`——那种情况由调用方的
 * `JSON.parse` 报错，本函数不抢它的职责。
 *
 * @param {string} text JSON 文本。
 * @returns {{key: string, path: string} | null} 重复键及其尽力而为的路径；没有重复时 `null`。
 */
export function findDuplicateJsonKey(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return null;
  }
  const total = text.length;
  /** @type {Array<{type: 'object' | 'array', keys: Set<string>, path: string, expectKey: boolean, lastKey: string | null}>} */
  const stack = [];
  let index = 0;

  const childPath = (parent, key) => {
    if (parent === undefined) {
      return '$';
    }
    if (parent.type === 'object') {
      return key === null ? parent.path : `${parent.path}.${key}`;
    }
    return `${parent.path}[]`;
  };

  while (index < total) {
    const code = text.charCodeAt(index);
    if (code === 0x22) {
      const read = readString(text, index);
      if (read === null) {
        return null;
      }
      index = read.end;
      const context = stack[stack.length - 1];
      if (context !== undefined && context.type === 'object' && context.expectKey) {
        const duplicate = registerKey(context, read.value);
        if (duplicate !== null) {
          return duplicate;
        }
        context.expectKey = false;
        context.lastKey = read.value;
      }
      continue;
    }
    if (code === 0x7b) {
      const parent = stack[stack.length - 1];
      stack.push({
        type: 'object',
        keys: new Set(),
        path: childPath(parent, parent === undefined ? null : parent.lastKey),
        expectKey: true,
        lastKey: null,
      });
      index += 1;
      continue;
    }
    if (code === 0x5b) {
      const parent = stack[stack.length - 1];
      stack.push({
        type: 'array',
        keys: new Set(),
        path: childPath(parent, parent === undefined ? null : parent.lastKey),
        expectKey: false,
        lastKey: null,
      });
      index += 1;
      continue;
    }
    if (code === 0x7d || code === 0x5d) {
      stack.pop();
      index += 1;
      continue;
    }
    if (code === 0x2c) {
      const context = stack[stack.length - 1];
      if (context !== undefined && context.type === 'object') {
        context.expectKey = true;
      }
      index += 1;
      continue;
    }
    index += 1;
  }
  return null;
}
