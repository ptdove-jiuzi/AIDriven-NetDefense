/**
 * B7 · 设置组 `diagnostics`（诊断）——字段全部来自 GET /settings/schema
 * 作者：PT-dove
 *
 * 只读项（apiPort / exportBundleLastAt）不可编辑；actions[]（exportBundle / rotateToken）
 * 在 0.0.1 是 501，本页显示原因，不假成功。
 */
import { el } from '../../components/ui/dom.js';
import { asArray, formatTimestamp, getPath, groupItems, renderActions, renderItems, section } from './shared.js';

export const id = 'diagnostics';

export function render(env) {
  const { t, locale, server } = env;
  const items = groupItems(env.schema, id);
  const actions = renderActions(env, id);
  const apiPort = getPath(env.draft, 'diagnostics.apiPort');
  const exportLastAt = getPath(env.draft, 'diagnostics.exportBundleLastAt');
  const warnings = asArray(server && server.warnings);

  return el('div', { class: 'stack' }, [
    section({
      id: 'settings-group-diagnostics',
      title: t('settings.group.diagnostics', 'Diagnostics'),
      note: t(
        'settings.diagnostics.note',
        'Log level changes require a restart. The API port and the last export timestamp are owned by the daemon (read-only).',
      ),
      body: [
        el('div', { class: 'settings-kv' }, [
          el('span', { class: 'settings-kv__key', text: t('settings.diagnostics.api-port', 'API port') }),
          el('span', { class: 'mono', text: apiPort == null ? '—' : String(apiPort) }),
          el('span', { class: 'settings-kv__key', text: t('settings.diagnostics.export-last-at', 'Last export') }),
          el('span', { text: formatTimestamp(exportLastAt, locale) }),
        ]),
        ...renderItems(env, items),
      ],
    }),
    warnings.length
      ? section({
          title: t('settings.warnings', 'Warnings'),
          note: t(
            'settings.diagnostics.warnings-note',
            'These come from GET /api/v1/settings. A corrupt file is never overwritten and defaults are loaded instead.',
          ),
          body: [
            el(
              'ul',
              { class: 'settings-warnings' },
              warnings.map((warning) => el('li', { text: String(warning) })),
            ),
          ],
        })
      : null,
    actions,
  ]);
}
