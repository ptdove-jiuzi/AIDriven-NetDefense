/**
 * AIDriven NetDefense · WebUI v2 · 视图占位（不白屏兜底）
 * B2 / PT-dove
 *
 * 合同 §7.2：视图模块缺失 / mount 抛错 → 壳渲染 `errors.view-unavailable` 空态，
 * **保留导航与外壳**，永不白屏。
 *
 * 本模块与其它视图同签名：`export async function mount(root, ctx) → { destroy() }`，
 * 因此 router 可以用完全一样的加载路径挂载它。
 */

import { el } from '../components/ui/dom.js';
import { empty } from '../components/ui/empty.js';

/**
 * @param {HTMLElement} root 视图容器（router 已清空）
 * @param {{i18n?: object, params?: object, toast?: Function}|undefined} ctx
 * @returns {Promise<{destroy: Function}>}
 */
export async function mount(root, ctx) {
  const context = ctx == null ? {} : ctx;
  const i18n = context.i18n;
  const t = (key) => {
    if (i18n && typeof i18n.t === 'function') return i18n.t(key);
    return key;
  };

  const section = el(
    'section',
    {
      class: 'page stack',
      data: { view: 'placeholder', 'view-unavailable': 'true' },
      role: 'status',
    },
    [
      empty({
        iconName: 'warning',
        title: t('errors.view-unavailable'),
        body: t('app.view-unavailable-hint'),
      }),
    ],
  );

  root.appendChild(section);

  return {
    destroy() {
      section.remove();
    },
  };
}
