/**
 * B7 · 设置组 `collection`（采集）——字段全部来自 GET /settings/schema
 * 作者：PT-dove
 */
import { el } from '../../components/ui/dom.js';
import { badge } from '../../components/ui/badge.js';
import { groupItems, renderItems, section } from './shared.js';

export const id = 'collection';

export function render(env) {
  const { t, group } = env;
  const items = groupItems(env.schema, id);
  const restartItems = items.filter((item) => item.appliesAt === 'restart');
  return el('div', { class: 'stack' }, [
    section({
      id: 'settings-group-collection',
      title: t('settings.group.collection', 'Collection'),
      note: t(
        'settings.collection.note',
        'Channel and polling changes apply on the next collection cycle; retention changes require a restart.',
      ),
      body: renderItems(env, items),
    }),
    restartItems.length
      ? section({
          title: t('settings.group.collection.restart', 'Requires restart'),
          note: t(
            'settings.collection.restart-note',
            'These fields are stored immediately but the collector only reads them when it restarts.',
          ),
          body: [
            el(
              'div',
              { class: 'settings-badges' },
              restartItems.map((item) =>
                badge({ tone: 'warn', text: item.path }),
              ),
            ),
          ],
        })
      : null,
    group && group.appliesAt
      ? el('p', {
          class: 'faint',
          text: t('settings.collection.group-applies-at', 'Group default: {value}', { value: group.appliesAt }),
        })
      : null,
  ]);
}
