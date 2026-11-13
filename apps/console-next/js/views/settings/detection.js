/**
 * B7 · 设置组 `detection`（检测）——字段全部来自 GET /settings/schema
 * 作者：PT-dove
 *
 * severityMapping 与 allowlist 的控件同样由 schema 描述生成：
 * - severityMapping：键集合取自 schema item.default，值候选取自该默认对象的键（严重度集合）
 * - allowlist：子字段来自 item.fields（id/kind/pattern/note），没有手写字段表
 */
import { el } from '../../components/ui/dom.js';
import { groupItems, renderItems, section } from './shared.js';

export const id = 'detection';

export function render(env) {
  const { t } = env;
  const items = groupItems(env.schema, id);
  return el('div', { class: 'stack' }, [
    section({
      id: 'settings-group-detection',
      title: t('settings.group.detection', 'Detection'),
      note: t(
        'settings.detection.note',
        'Rule packs and thresholds apply on the next collection cycle. Allowlist entries suppress matching alerts only — they never hide raw events.',
      ),
      body: renderItems(env, items),
    }),
    section({
      title: t('settings.detection.severity-note', 'Severity mapping'),
      note: t(
        'settings.detection.severity-mapping-note',
        'Maps the severity a rule reports onto the severity shown and routed by this console. Unknown severities are rejected by the daemon.',
      ),
      body: [
        el('p', {
          class: 'faint',
          text: t(
            'settings.detection.allowlist-note',
            'Allowlist patterns are matched literally by the collector; the note field is for humans only.',
          ),
        }),
      ],
    }),
  ]);
}
