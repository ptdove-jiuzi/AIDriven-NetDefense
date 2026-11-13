/**
 * B7 · 设置组 `about`（关于）——只读、由 schema + /status 注入，不入 settings 文件
 * 作者：PT-dove
 *
 * 字段值来自 GET /api/v1/settings 的只读 overlay（B8 实现），缺失时回落到 schema default；
 * 本模块不写任何值，也没有保存语义。产品名固定为 AIDriven NetDefense / 网域智防。
 */
import { el } from '../../components/ui/dom.js';
import { groupItems, itemLabel, getPath } from './shared.js';

export const id = 'about';

export function render(env) {
  const { t } = env;
  const items = groupItems(env.schema, id);
  const values = new Map(
    items.map((item) => {
      const live = getPath(env.draft, item.path);
      return [item.path, live === undefined ? item.default : live];
    }),
  );

  const scalar = (path) => items.find((item) => item.path === path) || null;
  const versionItem = scalar('about.version');
  const licenseItem = scalar('about.license');
  const privacyItem = scalar('about.privacy');
  const changelogItem = scalar('about.changelog');

  const version = versionItem ? values.get(versionItem.path) : null;
  const license = licenseItem ? values.get(licenseItem.path) : null;
  const privacyCode = privacyItem ? values.get(privacyItem.path) : null;
  const changelog = changelogItem ? values.get(changelogItem.path) : [];

  return el('div', { class: 'stack' }, [
    el('section', { class: 'settings-section', id: 'settings-group-about' }, [
      el('div', { class: 'settings-section__head' }, [
        el('div', { class: 'settings-section__headings' }, [
          el('h2', { class: 'settings-section__title', text: t('settings.group.about', 'About') }),
          el('p', { class: 'settings-section__note', text: t('settings.about.note', 'Injected by the daemon; never written to settings.json.') }),
        ]),
      ]),
      el('div', { class: 'settings-section__body' }, [
        el('div', { class: 'settings-kv' }, [
          el('span', { class: 'settings-kv__key', text: t('settings.about.product', 'Product') }),
          el('span', { text: 'AIDriven NetDefense · 网域智防' }),
          el('span', { class: 'settings-kv__key', text: t('settings.about.version', 'Version') }),
          el('span', { class: 'mono', text: version == null ? '—' : String(version) }),
          el('span', { class: 'settings-kv__key', text: t('settings.about.license', 'License') }),
          el('span', { class: 'mono', text: license == null ? '—' : String(license) }),
          el('span', { class: 'settings-kv__key', text: t('settings.about.privacy', 'Privacy') }),
          el('span', { text: t('settings.about.privacy-value', 'Local only, no telemetry, no cloud dependency.') }),
          el('span', { class: 'settings-kv__key', text: t('settings.about.privacy-code', 'Code') }),
          el('span', { class: 'mono', text: privacyCode == null ? '—' : String(privacyCode) }),
        ]),
        el('h3', { class: 'settings-section__title', text: t('settings.about.changelog', 'Changelog') }),
        Array.isArray(changelog) && changelog.length
          ? el(
              'ul',
              { class: 'settings-changelog' },
              changelog.map((entry) => el('li', { text: String(entry) })),
            )
          : el('p', { class: 'faint', text: t('settings.about.no-changelog', 'No changelog entries provided.') }),
        // 只读字段清单（schema 驱动，不手写）
        el(
          'p',
          { class: 'faint' },
          [
            el('span', { text: t('settings.about.fields', 'Read-only fields from the schema:') + ' ' }),
            el('code', {
              class: 'mono',
              text: items.map((item) => itemLabel(t, item)).join(' · '),
            }),
          ],
        ),
      ]),
    ]),
  ]);
}
