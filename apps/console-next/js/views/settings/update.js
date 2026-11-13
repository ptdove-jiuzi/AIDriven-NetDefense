/**
 * B7 · 设置组 `update`（更新）——字段全部来自 GET /settings/schema
 * 作者：PT-dove
 *
 * autoCheck 在 0.0.1 未接线（schema wired:false）；checkNow/rollback 在 actions[] 里
 * available:false，点击只解释原因，不假装成功（合同 §12.1 item 6）。
 */
import { el } from '../../components/ui/dom.js';
import { asArray, groupItems, renderActions, renderItems, section, formatTimestamp } from './shared.js';
import { getPath } from './shared.js';

export const id = 'update';

export function render(env) {
  const { t, locale } = env;
  const items = groupItems(env.schema, id);
  const actions = renderActions(env, id);
  const lastCheckedAt = getPath(env.draft, 'update.lastCheckedAt');
  const currentVersion = getPath(env.draft, 'update.currentVersion');

  return el('div', { class: 'stack' }, [
    section({
      id: 'settings-group-update',
      title: t('settings.group.update', 'Update'),
      note: t(
        'settings.update.note',
        'Update checking is not wired in 0.0.1. The fields below are stored and visibly marked as not in effect; no request leaves this machine.',
      ),
      body: [
        el('div', { class: 'settings-kv' }, [
          el('span', { class: 'settings-kv__key', text: t('settings.update.current-version', 'Current version') }),
          el('span', { class: 'mono', text: currentVersion == null ? '—' : String(currentVersion) }),
          el('span', { class: 'settings-kv__key', text: t('settings.update.last-checked-at', 'Last check') }),
          el('span', { text: formatTimestamp(lastCheckedAt, locale) }),
        ]),
        ...renderItems(env, items),
      ],
    }),
    actions,
    asArray(env.schema && env.schema.groups).length
      ? null
      : el('p', { class: 'faint', text: t('settings.update.empty-schema', 'Schema unavailable.') }),
  ]);
}
