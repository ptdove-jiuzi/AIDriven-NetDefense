/**
 * tests/console/css-cascade.mjs — 无依赖的最小 CSS 层叠演算（只回答一个问题：
 * 一个带 `hidden` 属性的元素，最终 `display` 是多少）。
 *
 * 为什么需要它：SEED-02 的真实缺陷不是「`hidden` 属性没设」，而是「作者样式
 * `.drawer { display:flex }` 在层叠里打败了 UA 的 `[hidden] { display:none }`」。
 * `tests/console/console-dom.test.js` 以前的断言只看 DOM 属性（`drawer.hidden === true`），
 * 所以把 `[hidden] { display:none !important }` 删掉它照样绿 —— 这就是 R6-002
 * 「全仓无断言能抓 SEED-02」。本模块把「哪些规则命中、谁赢」算出来，让断言能失败。
 *
 * 能力边界（刻意保守，不是通用 CSS 引擎）：
 * - 只支持**复合选择器**（tag / `.class` / `#id` / `[attr]` / `*` 及其组合）；
 *   含后代/子代/兄弟组合符（空格、`>`、`+`、`~`）的选择器无 DOM 上下文，一律视为不命中；
 * - 顶层 `@media` / `@keyframes` 等 at-rule 不求值；若其中出现会影响本元素的规则，
 *   `assertAtRulesHarmless()` 会抛错，而不是静默算错；
 * - 只算 `display` 一个属性（SEED-02 的判据属性）。
 *
 * 作者：PT-dove
 */

const DISPLAY = 'display';

/** 去掉注释（保留换行，行号不参与判据，但保持可读）。 */
export function stripComments(cssText) {
  return cssText.replace(/\/\*[\s\S]*?\*\//gu, '');
}

/**
 * 把样式表切成顶层块。返回 `{ rules: [{selector, body, order}], atRules: [{name, body}] }`。
 * 用花括号配平扫描，因此 `@media`/`@keyframes` 的嵌套不会破坏普通规则的解析。
 */
export function parseStyleSheet(cssText) {
  const text = stripComments(cssText);
  const rules = [];
  const atRules = [];
  let index = 0;
  let order = 0;
  while (index < text.length) {
    const open = text.indexOf('{', index);
    if (open === -1) break;
    const selector = text.slice(index, open).trim();
    let depth = 1;
    let cursor = open + 1;
    while (cursor < text.length && depth > 0) {
      const char = text[cursor];
      if (char === '{') depth += 1;
      else if (char === '}') depth -= 1;
      cursor += 1;
    }
    if (depth !== 0) throw new Error(`unbalanced braces after selector: ${JSON.stringify(selector)}`);
    const body = text.slice(open + 1, cursor - 1);
    if (selector.startsWith('@')) atRules.push({ name: selector.split(/\s+/u)[0], selector, body });
    else if (selector.length > 0) rules.push({ selector, body, order: order++ });
    index = cursor;
  }
  return { rules, atRules };
}

/** 按 `;` 切声明，忽略括号内的分号（如 `url(data:...;base64,...)`）。 */
function splitDeclarations(body) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const char of body) {
    if (char === '(') depth += 1;
    if (char === ')') depth = Math.max(0, depth - 1);
    if (char === ';' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim().length > 0) parts.push(current);
  return parts;
}

/** 解析一条规则的声明（只保留本模块关心的 `display`）。 */
export function parseDisplayDeclarations(body) {
  const declarations = [];
  for (const part of splitDeclarations(body)) {
    const colon = part.indexOf(':');
    if (colon === -1) continue;
    const property = part.slice(0, colon).trim().toLowerCase();
    if (property !== DISPLAY) continue;
    let value = part.slice(colon + 1).trim();
    const important = /!\s*important\s*$/iu.test(value);
    value = value.replace(/!\s*important\s*$/iu, '').trim().replace(/\s+/gu, ' ');
    declarations.push({ property, value, important });
  }
  return declarations;
}

/**
 * 解析一个复合选择器。返回 `null` 表示「含组合符/伪类等本模块不求值的形式」。
 * 返回 `{ tag, id, classes, attrs }`。
 */
export function parseCompoundSelector(selector) {
  const raw = selector.trim();
  if (raw.length === 0) return null;
  if (/[\s>+~]/u.test(raw)) return null;
  if (/[:(]/u.test(raw)) return null; // 伪类/伪元素不参与本判据
  const compound = { tag: null, id: null, classes: [], attrs: [] };
  let rest = raw;
  const tokenPattern = /^([a-zA-Z][\w-]*|\*|[.#][\w-]+|\[[^\]]+\])/u;
  while (rest.length > 0) {
    const match = tokenPattern.exec(rest);
    if (!match) return null;
    const token = match[1];
    if (token === '*') {
      // 通配符：不限制 tag
    } else if (token.startsWith('.')) compound.classes.push(token.slice(1));
    else if (token.startsWith('#')) compound.id = token.slice(1);
    else if (token.startsWith('[')) {
      const inner = token.slice(1, -1).trim();
      const equals = inner.indexOf('=');
      if (equals === -1) compound.attrs.push({ name: inner.trim().toLowerCase(), value: null });
      else {
        const name = inner.slice(0, equals).trim().toLowerCase();
        const value = inner.slice(equals + 1).trim().replace(/^["']|["']$/gu, '');
        compound.attrs.push({ name, value });
      }
    } else compound.tag = token.toLowerCase();
    rest = rest.slice(token.length);
  }
  return compound;
}

/**
 * 复合选择器是否命中元素。
 * element: `{ tag, id, classes, attrs }`（`attrs` 为小写属性名数组）。
 */
export function matchesCompound(selector, element) {
  const compound = parseCompoundSelector(selector);
  if (!compound) return false;
  if (compound.tag && compound.tag !== String(element.tag).toLowerCase()) return false;
  if (compound.id && compound.id !== element.id) return false;
  const classes = element.classes ?? [];
  if (!compound.classes.every((name) => classes.includes(name))) return false;
  for (const attr of compound.attrs) {
    const has = (element.attrs ?? []).some((entry) => entry.toLowerCase() === attr.name);
    if (!has) return false;
    if (attr.value !== null && String(element.attrValues?.[attr.name] ?? '') !== attr.value) return false;
  }
  return true;
}

/** 选择器优先级 [id, class/attr, type]。 */
export function specificityOf(selector) {
  const compound = parseCompoundSelector(selector);
  if (!compound) return [0, 0, 0];
  return [compound.id ? 1 : 0, compound.classes.length + compound.attrs.length, compound.tag ? 1 : 0];
}

const compareSpecificity = (left, right) => {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
};

/**
 * 算出一个元素最终的 `display` 与胜出规则。
 *
 * 元素模型：`{ tag, id, classes, attrs }`。
 * 层叠顺序（简化但覆盖本判据）：作者 `!important` > 作者普通 > UA 默认；
 * 同级按 specificity，再按源码顺序（后写胜）。
 * UA 默认按 HTML 规范：带 `hidden` 属性 → `display:none`。
 *
 * @returns {{ display: string, winner: { origin: string, important: boolean,
 *   selector: string|null, value: string } }}
 */
export function resolveDisplay(cssText, element) {
  const { rules, atRules } = parseStyleSheet(cssText);
  const candidates = [];
  if ((element.attrs ?? []).some((entry) => entry.toLowerCase() === 'hidden')) {
    candidates.push({
      origin: 'ua', important: false, specificity: [0, 0, 0], order: -1,
      selector: '[hidden] (UA)', value: 'none',
    });
  }
  for (const rule of rules) {
    for (const [selectorIndex, selector] of rule.selector.split(',').entries()) {
      if (!matchesCompound(selector, element)) continue;
      for (const declaration of parseDisplayDeclarations(rule.body)) {
        candidates.push({
          origin: 'author',
          important: declaration.important,
          specificity: specificityOf(selector),
          order: rule.order * 1000 + selectorIndex,
          selector: selector.trim(),
          value: declaration.value,
        });
      }
    }
  }
  let winner = null;
  for (const candidate of candidates) {
    if (winner === null) {
      winner = candidate;
      continue;
    }
    const byImportant = Number(candidate.important) - Number(winner.important);
    if (byImportant !== 0) {
      if (byImportant > 0) winner = candidate;
      continue;
    }
    const byOrigin = (candidate.origin === 'author' ? 1 : 0) - (winner.origin === 'author' ? 1 : 0);
    if (byOrigin !== 0) {
      if (byOrigin > 0) winner = candidate;
      continue;
    }
    const bySpecificity = compareSpecificity(candidate.specificity, winner.specificity);
    if (bySpecificity !== 0) {
      if (bySpecificity > 0) winner = candidate;
      continue;
    }
    if (candidate.order >= winner.order) winner = candidate;
  }
  if (winner === null) throw new Error('no display declaration resolved (element may be unstyled)');
  void atRules;
  return { display: winner.value, winner };
}

/** 样式表里是否存在「全局 `[hidden]{display:none !important}`」这条兜底。 */
export function hasGlobalHiddenImportant(cssText) {
  const { rules } = parseStyleSheet(cssText);
  return rules.some((rule) =>
    rule.selector.split(',').some((selector) => selector.trim() === '[hidden]')
    && parseDisplayDeclarations(rule.body).some((declaration) => declaration.important && declaration.value === 'none'));
}

/**
 * 断言被移除求值的 at-rule 里没有会影响本元素的规则。
 * 如果将来有人在 `@media` 里给 `[hidden]`/`#drawer`/`.drawer` 写 display，
 * 本演算就不可信，必须让测试红，而不是静默算错。
 */
export function assertAtRulesHarmless(cssText) {
  const { atRules } = parseStyleSheet(cssText);
  const suspicious = atRules.filter((rule) => /\[hidden\]|#drawer|\.drawer\b/u.test(rule.body));
  if (suspicious.length > 0) {
    throw new Error(`at-rule 内含会影响抽屉 display 的规则，层叠演算不再可信：${suspicious.map((r) => r.selector).join(' | ')}`);
  }
}

/**
 * 生成「缺陷等价样本」：把兜底规则里的 `!important` 删掉（与交付副本的失效形态一致）。
 * 只用于自检/先红证据，不改任何盘上文件。
 */
export function defectVariant(cssText) {
  const pattern = /\[hidden\]\s*\{\s*display\s*:\s*none\s*!important\s*;?\s*\}/u;
  if (!pattern.test(cssText)) throw new Error('source has no [hidden]{display:none !important} rule to downgrade');
  return cssText.replace(pattern, '[hidden] { display: none; }');
}

/** 交付副本里的失效形态是否被本演算判为 flex（用来证明断言真能抓住 SEED-02）。 */
export function drawerElement() {
  return { tag: 'aside', id: 'drawer', classes: ['drawer'], attrs: ['hidden'], attrValues: { hidden: '' } };
}

/** 从磁盘读一个 CSS 文件并按抽屉元素演算。 */
export function resolveDrawerDisplayFromFile(fsModule, filePath) {
  return resolveDisplay(fsModule.readFileSync(filePath, 'utf8'), drawerElement());
}
