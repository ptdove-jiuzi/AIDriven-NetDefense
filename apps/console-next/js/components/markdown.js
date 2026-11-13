/**
 * AIDriven NetDefense · WebUI v2 · 最小 Markdown 渲染
 * B4 / PT-dove
 *
 * 合同：docs/implementation/CONSOLE-V2-CONTRACT.md §7.7
 * - 全部节点经 `dom.js` 的 `el()` / `document.createTextNode()` 构造，**零 innerHTML/outerHTML**。
 * - 用户内容一律走 text node：`<script>` 一类输入只会成为可见文本，不会被解析成元素。
 * - 链接白名单只有 `http(s):` 与 `#/`（合同 §7.7：href 只允许 http(s): / #/ / mailto:，
 *   本视图按任务要求再收紧到 http(s): 与 #/，其余按纯文本渲染）。
 *
 * 支持子集（够用且可测）：
 *   粗体 **x** · 斜体 *x* · 行内码 `x` · 围栏代码块（三个反引号 + 语言）·
 *   无序列表（短横线 / 加号 / 星号开头）· 有序列表（1. 或 1)）· 链接 [label](url)
 * 未闭合围栏**安全退化为普通文本**，不会吞掉后续内容。
 *
 * 导出：renderMarkdown(source) → DocumentFragment · inlineNodes(source) → Node[]
 *       parseMarkdownBlocks(source) → block[] · isAllowedHref(url) → boolean
 */
import { el } from './ui/dom.js';

const FENCE_OPEN = /^\s{0,3}(`{3,})\s*([^\s`]*)\s*$/;
const FENCE_CLOSE = /^\s{0,3}`{3,}\s*$/;
const UL_ITEM = /^\s{0,3}[-*+]\s+(.*)$/;
const OL_ITEM = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/;

/**
 * 链接白名单：http(s): 与 #/（`#` 单独也接受，用于页内锚点）。
 * 其余（javascript:、data:、vbscript:、相对路径、裸 mailto:）一律不建 <a>。
 */
export function isAllowedHref(raw) {
  const value = String(raw == null ? '' : raw).trim();
  if (!value) return false;
  // 去掉控制字符与空白，防止 "java\nscript:" / "ｊavascript:" 一类绕过
  const probe = value.replace(/[\u0000-\u0020\u007f]+/g, '');
  if (probe.startsWith('#')) return probe === '#' || probe.startsWith('#/');
  return /^https?:\/\//i.test(probe);
}

function splitLines(source) {
  return String(source == null ? '' : source).replace(/\r\n?/g, '\n').split('\n');
}

/**
 * 块级解析：段落 / 围栏代码块 / 无序列表 / 有序列表。
 * 返回 [{type:'p', text}|{type:'code', lang, text}|{type:'ul'|'ol', items, start}]。
 */
export function parseMarkdownBlocks(source) {
  const lines = splitLines(source);
  const blocks = [];
  let paragraph = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push({ type: 'p', text: paragraph.join(' ') });
    paragraph = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      let close = i + 1;
      while (close < lines.length && !FENCE_CLOSE.test(lines[close])) close += 1;
      if (close < lines.length) {
        flushParagraph();
        blocks.push({ type: 'code', lang: fence[2] || '', text: lines.slice(i + 1, close).join('\n') });
        i = close + 1;
        continue;
      }
      // 未闭合围栏：按普通文本继续，绝不吞掉后文
      paragraph.push(line.trim());
      i += 1;
      continue;
    }
    if (line.trim() === '') {
      flushParagraph();
      i += 1;
      continue;
    }
    const ul = UL_ITEM.exec(line);
    const ol = OL_ITEM.exec(line);
    if (ul || ol) {
      flushParagraph();
      const ordered = Boolean(ol);
      const start = ordered ? Number.parseInt(ol[1], 10) : 1;
      const items = [];
      while (i < lines.length) {
        const match = ordered ? OL_ITEM.exec(lines[i]) : UL_ITEM.exec(lines[i]);
        if (!match) break;
        items.push(ordered ? match[2] : match[1]);
        i += 1;
      }
      blocks.push({ type: ordered ? 'ol' : 'ul', items, start });
      continue;
    }
    paragraph.push(line.trim());
    i += 1;
  }
  flushParagraph();
  return blocks;
}

/** 找到可当作斜体收尾的单个 '*'（跳过 '**' 的第一个字符） */
function findEmClose(source, from) {
  let index = source.indexOf('*', from);
  while (index !== -1) {
    if (source[index + 1] === '*') {
      index = source.indexOf('*', index + 2);
      continue;
    }
    return index;
  }
  return -1;
}

/** 解析 [label](url)；不合法返回 null */
function parseLink(source, start) {
  const labelEnd = source.indexOf(']', start + 1);
  if (labelEnd < 0) return null;
  if (source[labelEnd + 1] !== '(') return null;
  const urlEnd = source.indexOf(')', labelEnd + 2);
  if (urlEnd < 0) return null;
  const label = source.slice(start + 1, labelEnd);
  const url = source.slice(labelEnd + 2, urlEnd).trim();
  if (!url) return null;
  return { label, url, end: urlEnd + 1 };
}

/**
 * 行内解析：粗体 / 斜体 / 行内码 / 链接。
 * 返回 Node[]（text node 与元素混合，全部经 dom.js 构造）。
 */
export function inlineNodes(source) {
  const value = String(source == null ? '' : source);
  const nodes = [];
  let buffer = '';
  const flush = () => {
    if (!buffer) return;
    nodes.push(document.createTextNode(buffer));
    buffer = '';
  };

  let i = 0;
  while (i < value.length) {
    const ch = value[i];

    if (ch === '`') {
      const end = value.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        nodes.push(el('code', { class: 'md-code-inline' }, value.slice(i + 1, end)));
        i = end + 1;
        continue;
      }
    }

    if (ch === '*' && value[i + 1] === '*') {
      const end = value.indexOf('**', i + 2);
      if (end > i + 2) {
        const inner = value.slice(i + 2, end);
        if (inner.trim()) {
          flush();
          nodes.push(el('strong', { class: 'md-strong' }, inlineNodes(inner)));
          i = end + 2;
          continue;
        }
      }
    }

    if (ch === '*') {
      const end = findEmClose(value, i + 1);
      if (end > i + 1) {
        const inner = value.slice(i + 1, end);
        if (inner.trim()) {
          flush();
          nodes.push(el('em', { class: 'md-em' }, inlineNodes(inner)));
          i = end + 1;
          continue;
        }
      }
    }

    if (ch === '[') {
      const link = parseLink(value, i);
      if (link) {
        flush();
        if (isAllowedHref(link.url)) {
          nodes.push(
            el(
              'a',
              {
                class: 'md-link',
                href: link.url,
                rel: 'noreferrer noopener',
                target: '_blank',
              },
              inlineNodes(link.label),
            ),
          );
        } else {
          // 非白名单链接：整段按原文渲染，不建 <a>（避免 javascript:/data: 一类）
          nodes.push(document.createTextNode(value.slice(i, link.end)));
        }
        i = link.end;
        continue;
      }
    }

    buffer += ch;
    i += 1;
  }
  flush();
  return nodes;
}

function renderBlock(block) {
  if (!block) return null;
  if (block.type === 'p') {
    return el('p', { class: 'md-p' }, inlineNodes(block.text));
  }
  if (block.type === 'code') {
    return el(
      'pre',
      { class: 'md-pre', data: block.lang ? { lang: block.lang } : null },
      [el('code', { class: 'md-code' }, block.text)],
    );
  }
  if (block.type === 'ul') {
    return el(
      'ul',
      { class: 'md-list' },
      block.items.map((item) => el('li', { class: 'md-li' }, inlineNodes(item))),
    );
  }
  if (block.type === 'ol') {
    return el(
      'ol',
      { class: 'md-list md-list--ordered', start: block.start > 1 ? block.start : null },
      block.items.map((item) => el('li', { class: 'md-li' }, inlineNodes(item))),
    );
  }
  return null;
}

/** renderMarkdown(source) → DocumentFragment（不修改任何既有 DOM） */
export function renderMarkdown(source) {
  const fragment = document.createDocumentFragment();
  for (const block of parseMarkdownBlocks(source)) {
    const node = renderBlock(block);
    if (node) fragment.appendChild(node);
  }
  return fragment;
}
