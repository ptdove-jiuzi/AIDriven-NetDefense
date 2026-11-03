// author: PT-dove
// 对抗语料的 DTO 构造器。
//
// 所有字段都是合成值（example.com / 192.0.2.0-24 文档地址段 / 固定的 UUID 与摘要），
// 不含任何真实用户、真实主机、真实日志内容。需要"看起来像注入"的字段一律显式标注，
// 便于审查者一眼区分"样本"与"真实数据"。

import { canonicalDigest } from '../../../packages/contracts/src/index.js';

export const UUID_A = '11111111-1111-4111-8111-111111111111';
export const UUID_B = '22222222-2222-4222-8222-222222222222';
export const UUID_C = '33333333-3333-4333-8333-333333333333';
export const UUID_D = '44444444-4444-4444-8444-444444444444';
export const HEX_A = 'a'.repeat(64);
export const HEX_B = 'b'.repeat(64);
export const HEX_C = 'c'.repeat(64);
export const HEX_ZERO = '0'.repeat(64);
export const BOOT_ID = '0123456789abcdef0123456789abcdef';
export const SYNTHETIC_HOST = 'lab-host.example.test';
export const SYNTHETIC_SOURCE = 'proc.win';

/**
 * 合成遥测事件（payload 摘要按内容现算，便于构造"摘要被替换"的负向样本）。
 *
 * @param {object} [overrides] 覆盖字段。
 * @returns {object} 未冻结的事件对象。
 */
export function telemetryEvent(overrides = {}) {
  const payload = overrides.payload ?? { process_name: 'example.exe', pid: 4242, elevated: false };
  return {
    schemaVersion: '1.0',
    event_id: UUID_A,
    stable_source_id: SYNTHETIC_SOURCE,
    collector_instance_id: UUID_B,
    source_generation: 3,
    boot_id: BOOT_ID,
    source_seq: 17,
    observed_at: '2026-01-01T00:00:00Z',
    received_at: '2026-01-01T00:00:00.500Z',
    type: 'process.created',
    severity: 'medium',
    payload,
    integrity: { algorithm: 'sha256', digest: canonicalDigest(payload) },
    ...overrides,
  };
}

/**
 * 合成 Finding。
 *
 * @param {object} [overrides] 覆盖字段。
 * @returns {object} Finding 对象。
 */
export function finding(overrides = {}) {
  return {
    schemaVersion: '1.0',
    finding_id: UUID_C,
    rule_id: 'corpus.example-rule',
    rule_version: '1.0.0',
    event_ids: [UUID_D],
    fingerprint: HEX_A,
    severity: 'high',
    status: 'new',
    first_seen: '2026-01-01T00:00:00Z',
    last_seen: '2026-01-01T00:00:01Z',
    count: 1,
    evidence_refs: [],
    ...overrides,
  };
}

/**
 * 合成 Alert。
 *
 * @param {object} [overrides] 覆盖字段。
 * @returns {object} Alert 对象。
 */
export function alert(overrides = {}) {
  return {
    schemaVersion: '1.0',
    alert_id: UUID_B,
    rule_id: 'corpus.example-rule',
    rule_version: '1.0.0',
    fingerprint: HEX_A,
    severity: 'high',
    status: 'new',
    first_seen: '2026-01-01T00:00:00Z',
    last_seen: '2026-01-01T00:00:01Z',
    window_start: '2026-01-01T00:00:00Z',
    window_end: '2026-01-01T00:15:00Z',
    count: 1,
    event_ids: [UUID_C],
    event_ids_truncated: false,
    evidence_refs: [],
    ...overrides,
  };
}

/**
 * 合成 rule pack（一条 condition 规则）。
 *
 * @param {object} [overrides] 覆盖条件规则字段。
 * @returns {object} rule pack。
 */
export function rulePack(overrides = {}) {
  return {
    schemaVersion: '1.0',
    packId: 'security-corpus',
    packVersion: '1.0.0',
    rules: [
      {
        ruleId: 'corpus.condition',
        version: '1.0.0',
        type: 'condition',
        severity: 'high',
        fields: ['process.name'],
        fingerprint: ['process.name'],
        when: { field: 'process.name', operator: 'eq', value: 'example-process' },
        ...overrides,
      },
    ],
  };
}

/**
 * 合成检测引擎事件（detection 包的内部事件形状，不是 TelemetryEvent 合同）。
 *
 * @param {object} [overrides] 覆盖字段。
 * @returns {object} 事件对象。
 */
export function detectionEvent(overrides = {}) {
  return {
    eventId: 'evt-0001',
    observedAt: 1_700_000_000_000,
    type: 'process_start',
    source: '192.0.2.10',
    severity: 'info',
    fields: { process: { name: 'example-process', path: '/opt/example/tool' } },
    ...overrides,
  };
}

/** 插件包内入口文件的默认相对路径。 */
export const PLUGIN_ENTRY = 'lib/index.js';
/** 合法入口源码。 */
export const PLUGIN_ENTRY_SOURCE = 'export function apply() {}\n';

/**
 * 最小合法 plugin.json。
 *
 * @param {object} [overrides] 覆盖字段。
 * @returns {object} plugin.json 文档。
 */
export function pluginManifest(overrides = {}) {
  return {
    schemaVersion: '1.0',
    id: 'com.example.anomaly-notes',
    name: 'Anomaly Notes',
    version: '1.0.0',
    api: 'aegis-extension-v1',
    engine: { dsh: '0.2.2-alpha.2' },
    entry: PLUGIN_ENTRY,
    permissions: ['analysis.dto.read'],
    ...overrides,
  };
}

/**
 * 最小合法 package.json。
 *
 * @param {object} [overrides] 覆盖字段。
 * @returns {object} package.json 文档。
 */
export function pluginPackageJson(overrides = {}) {
  return {
    name: 'com.example.anomaly-notes',
    version: '1.0.0',
    type: 'module',
    main: PLUGIN_ENTRY,
    exports: { '.': { default: `./${PLUGIN_ENTRY}` } },
    peerDependencies: { '@deepseek-ai/cordis': '4.0.6-alpha.1' },
    ...overrides,
  };
}

/**
 * 构造一个完整的插件目录（package.json + plugin.json + 入口）。
 *
 * @param {ReturnType<typeof import('./harness.js').createSandbox>} sandbox 临时目录。
 * @param {{ manifest?: object, packageJson?: object, entrySource?: string, entryPath?: string }} [options] 覆盖项。
 * @returns {string} 插件目录绝对路径。
 */
export function writePluginDirectory(sandbox, options = {}) {
  const {
    manifest = pluginManifest(),
    packageJson = pluginPackageJson(),
    entrySource = PLUGIN_ENTRY_SOURCE,
    entryPath = PLUGIN_ENTRY,
  } = options;
  const directory = sandbox.mkdir('plugin');
  sandbox.write('plugin/plugin.json', JSON.stringify(manifest, null, 2));
  sandbox.write('plugin/package.json', JSON.stringify(packageJson, null, 2));
  sandbox.write(`plugin/${entryPath}`, entrySource);
  return directory;
}
