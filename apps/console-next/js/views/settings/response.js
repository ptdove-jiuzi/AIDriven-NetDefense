/**
 * B7 · 设置组 `response`（响应）——字段全部来自 GET /settings/schema
 * 作者：PT-dove
 *
 * 0.0.1 没有执行器：executionEnabled 只读、动作目录只展示决策、
 * runAction 在 schema.actions 里 available:false → 只解释原因，绝不假成功。
 */
import { el } from '../../components/ui/dom.js';
import { badge } from '../../components/ui/badge.js';
import { asArray, groupItems, renderActions, renderItems, section, toKebab } from './shared.js';

export const id = 'response';

export function render(env) {
  const { t, schema } = env;
  const items = groupItems(env.schema, id);
  const catalog = asArray(schema.actionCatalog);
  const actions = renderActions(env, id);

  return el('div', { class: 'stack' }, [
    section({
      id: 'settings-group-response',
      title: t('settings.group.response', 'Response'),
      note: t(
        'settings.response.note',
        '0.0.1 never executes a response action: approvals are recorded, not carried out (EXECUTION_DISABLED). The action matrix documents intent only.',
      ),
      body: renderItems(env, items),
    }),
    catalog.length
      ? section({
          title: t('settings.response.catalog', 'Action catalogue'),
          note: t(
            'settings.response.catalog-note',
            'The catalogue comes from the daemon (settings/schema#actionCatalog); the matrix above only records the policy.',
          ),
          body: [
            el(
              'div',
              { class: 'settings-kv' },
              catalog.flatMap((action) => [
                el('span', { class: 'settings-kv__key', text: action.id }),
                el('span', {}, [
                  badge({
                    tone: action.decision === 'needs_approval' ? 'warn' : 'neutral',
                    text: t('settings.decision.' + toKebab(action.decision), action.decision),
                  }),
                ]),
              ]),
            ),
          ],
        })
      : null,
    actions,
  ]);
}
