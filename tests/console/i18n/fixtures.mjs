/**
 * tests/console/i18n/fixtures.mjs — 造临时词条目录，用来证明校验脚本「该红的时候会红」。
 *
 * 断言重点不是"真词条写得好不好"，而是 i18n-check.mjs 面对**故意做坏的假文件**
 * 是否真的报错并以非 0 退出。所以这里的 fixture 只有 6 条 key，但七种语言齐全。
 *
 * 作者：PT-dove
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 六条最小词条：一条带插值、一组复数（one/few/many/other）、一条按钮标签。 */
export const MINIMAL_TABLES = {
  en: {
    'greet.hello': 'Hello {name}',
    'list.one': '1 item',
    'list.few': '{count} items',
    'list.many': '{count} items',
    'list.other': '{count} items',
    'action.save': 'Save',
  },
  'zh-CN': {
    'greet.hello': '你好 {name}',
    'list.one': '1 项',
    'list.few': '{count} 项',
    'list.many': '{count} 项',
    'list.other': '{count} 项',
    'action.save': '保存',
  },
  ja: {
    'greet.hello': 'こんにちは {name}',
    'list.one': '1 件',
    'list.few': '{count} 件',
    'list.many': '{count} 件',
    'list.other': '{count} 件',
    'action.save': '保存',
  },
  ko: {
    'greet.hello': '안녕하세요 {name}',
    'list.one': '1개',
    'list.few': '{count}개',
    'list.many': '{count}개',
    'list.other': '{count}개',
    'action.save': '저장',
  },
  es: {
    'greet.hello': 'Hola {name}',
    'list.one': '1 elemento',
    'list.few': '{count} elementos',
    'list.many': '{count} elementos',
    'list.other': '{count} elementos',
    'action.save': 'Guardar',
  },
  ru: {
    'greet.hello': 'Привет, {name}',
    'list.one': '1 элемент',
    'list.few': '{count} элемента',
    'list.many': '{count} элементов',
    'list.other': '{count} элемента',
    'action.save': 'Сохранить',
  },
  th: {
    'greet.hello': 'สวัสดี {name}',
    'list.one': '1 รายการ',
    'list.few': '{count} รายการ',
    'list.many': '{count} รายการ',
    'list.other': '{count} รายการ',
    'action.save': 'บันทึก',
  },
};

/**
 * 写一套临时词条。
 *
 * @param {(tables: object, dir: string) => void} [mutate] 在落盘前做坏的办法。
 * @returns {string} 临时目录。
 */
export function writeLocales(mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-check-'));
  const tables = JSON.parse(JSON.stringify(MINIMAL_TABLES));
  if (typeof mutate === 'function') mutate(tables, dir);
  for (const [locale, table] of Object.entries(tables)) {
    fs.writeFileSync(path.join(dir, `${locale}.json`), `${JSON.stringify(table, null, 2)}\n`, 'utf8');
  }
  return dir;
}

/** 删除临时目录。 */
export function cleanup(dir) {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
}
