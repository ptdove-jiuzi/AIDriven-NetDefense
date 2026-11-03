import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import contracts, {
  ALERT_STATUSES,
  APPROVAL_STATES,
  AUDIT_ACTOR_TYPES,
  canonicalDigest,
  canonicalize,
  canonicalSize,
  ContractError,
  contracts as namespace,
  DATA_CLASSIFICATIONS,
  ERROR_CODES,
  LIMITS,
  MODEL_REQUEST_STATES,
  negotiateSchemaVersion,
  parseAlert,
  parseAnalysisReport,
  parseAnalysisRequest,
  parseApproval,
  parseAuditEvent,
  parseEvidenceRef,
  parseExecutionGrant,
  parseFinding,
  parseModelRequest,
  parseResponseProposal,
  parseSchemaVersion,
  parseStrictJson,
  parseTelemetryEvent,
  RISK_LEVELS,
  ROLE_NAMES,
  SEVERITY_LEVELS,
  SUPPORTED_SCHEMA_VERSIONS,
  validateAlert,
  validateAnalysisReport,
  validateAnalysisRequest,
  validateApproval,
  validateAuditEvent,
  validateEvidenceRef,
  validateExecutionGrant,
  validateFinding,
  validateModelRequest,
  validateResponseProposal,
  validateTelemetryEvent,
  verifyAuditChain,
  verifyGrantApprovalBinding,
  verifyProposalApprovalBinding,
} from '../../packages/contracts/src/index.js';
import { expectCode } from './helpers.js';
import * as ns from '../../packages/contracts/src/index.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SRC_ROOT = join(REPO_ROOT, 'packages', 'contracts', 'src');

const REQUIRED_EXPORTS = {
  ContractError,
  ERROR_CODES,
  LIMITS,
  SUPPORTED_SCHEMA_VERSIONS,
  parseSchemaVersion,
  negotiateSchemaVersion,
  parseStrictJson,
  canonicalize,
  canonicalDigest,
  canonicalSize,
  parseTelemetryEvent,
  validateTelemetryEvent,
  parseAnalysisRequest,
  validateAnalysisRequest,
  parseAnalysisReport,
  validateAnalysisReport,
  parseResponseProposal,
  validateResponseProposal,
  parseApproval,
  validateApproval,
  parseExecutionGrant,
  validateExecutionGrant,
  parseFinding,
  validateFinding,
  parseAlert,
  validateAlert,
  parseEvidenceRef,
  validateEvidenceRef,
  parseModelRequest,
  validateModelRequest,
  parseAuditEvent,
  validateAuditEvent,
  verifyAuditChain,
  verifyProposalApprovalBinding,
  verifyGrantApprovalBinding,
  SEVERITY_LEVELS,
  RISK_LEVELS,
  APPROVAL_STATES,
  ROLE_NAMES,
  DATA_CLASSIFICATIONS,
  ALERT_STATUSES,
  AUDIT_ACTOR_TYPES,
  MODEL_REQUEST_STATES,
};

const APPROVAL_GRANT_WHITELIST = new Set([
  'verifyGrantApprovalBinding',
  'verifyProposalApprovalBinding',
  'parseExecutionGrant',
  'validateExecutionGrant',
  'parseApproval',
  'validateApproval',
  'APPROVAL_STATES',
]);

/**
 * 公开接口的完整清单（穷举白名单）。
 *
 * 旧守卫用"名字里带 grant/approve"的正则 + 黑名单，改个名字就能绕过。
 * 这里改成精确集合比对：任何新增导出都必须在本清单里显式登记，
 * 评审时不可能漏看一个"toGrant"式的隐式升级入口。
 *
 * 比对对象是 `import * as ns` 的命名空间，而不是 `contracts` 对象：
 * 命名空间会额外带上 `contracts` 与 `default` 两个名字，并且只要在 index.js 里
 * 多写一行 `export const x = 1`，命名空间就会多一个键 —— 而 `contracts` 对象不会。
 * 这正是旧写法漏掉的口子。
 */
const EXPECTED_EXPORT_NAMES = Object.freeze([
  'ALERT_STATUSES',
  'APPROVAL_STATES',
  'AUDIT_ACTOR_TYPES',
  'ContractError',
  'DATA_CLASSIFICATIONS',
  'ERROR_CODES',
  'LIMITS',
  'MODEL_REQUEST_STATES',
  'RISK_LEVELS',
  'ROLE_NAMES',
  'SEVERITY_LEVELS',
  'SUPPORTED_SCHEMA_VERSIONS',
  'TARGET_KINDS',
  'canonicalDigest',
  'canonicalSize',
  'canonicalize',
  'contracts',
  'default',
  'negotiateSchemaVersion',
  'parseAlert',
  'parseAnalysisReport',
  'parseAnalysisRequest',
  'parseApproval',
  'parseAuditEvent',
  'parseEvidenceRef',
  'parseExecutionGrant',
  'parseFinding',
  'parseModelRequest',
  'parseResponseProposal',
  'parseSchemaVersion',
  'parseStrictJson',
  'parseTelemetryEvent',
  'validateAlert',
  'validateAnalysisReport',
  'validateAnalysisRequest',
  'validateApproval',
  'validateAuditEvent',
  'validateEvidenceRef',
  'validateExecutionGrant',
  'validateFinding',
  'validateModelRequest',
  'validateResponseProposal',
  'validateTelemetryEvent',
  'verifyAuditChain',
  'verifyGrantApprovalBinding',
  'verifyProposalApprovalBinding',
].sort());

test('命名空间是冻结的且包含全部必需导出', () => {
  assert.ok(Object.isFrozen(namespace));
  for (const [name, exported] of Object.entries(REQUIRED_EXPORTS)) {
    assert.equal(namespace[name], exported, `命名空间缺少 ${name}`);
  }
  assert.equal(contracts, namespace);
});

test('导出的名字集合与显式登记的白名单完全一致', () => {
  assert.deepStrictEqual(Object.keys(ns).sort(), [...EXPECTED_EXPORT_NAMES]);
  // 逐个名字做一次自有属性检查，避免 getter/继承属性混进 Object.keys。
  const ownCount = Object.keys(ns).length;
  assert.equal(Object.getOwnPropertyNames(ns).length, ownCount);
  // 命名空间比 contracts 对象多出的两个名字必须正好是 contracts 与 default。
  const extra = Object.keys(ns).filter((key) => !Object.prototype.hasOwnProperty.call(namespace, key));
  assert.deepStrictEqual(extra.sort(), ['contracts', 'default']);
});

test('ESM 命名空间恰好 46 个名字：44 个具名导出 + contracts + default', () => {
  const names = Object.keys(ns);
  assert.equal(names.length, EXPECTED_EXPORT_NAMES.length);
  assert.equal(names.length, 46);
  assert.ok(names.includes('contracts'));
  assert.ok(names.includes('default'));
  assert.equal(ns.default, ns.contracts);
  assert.equal(ns.contracts, namespace);
  assert.equal(ns.parseTelemetryEvent, namespace.parseTelemetryEvent);
});

test('白名单里没有任何把展示对象升级为授权或自动审批的入口', () => {
  for (const key of [...Object.keys(namespace), ...Object.keys(ns)]) {
    if (!/grant|approve/i.test(key)) continue;
    assert.ok(
      APPROVAL_GRANT_WHITELIST.has(key),
      `导出 ${key} 不在允许的审批/授权白名单内`,
    );
  }
  for (const forbidden of ['toGrant', 'proposalToGrant', 'grantFrom', 'approve', 'autoApprove', 'coerceGrant']) {
    assert.equal(Object.prototype.hasOwnProperty.call(namespace, forbidden), false, `不应导出 ${forbidden}`);
    assert.equal(Object.prototype.hasOwnProperty.call(ns, forbidden), false, `命名空间不应导出 ${forbidden}`);
  }
});

test('所有校验器失败时抛 ContractError 且带非空 code 与 $ 开头的 path', () => {
  const validators = [
    validateTelemetryEvent,
    validateAnalysisRequest,
    validateAnalysisReport,
    validateResponseProposal,
    validateApproval,
    validateExecutionGrant,
    validateFinding,
    validateAlert,
    validateEvidenceRef,
    validateModelRequest,
    validateAuditEvent,
  ];
  for (const validate of validators) {
    for (const input of [{}, null]) {
      let captured;
      assert.throws(() => {
        try {
          validate(input);
        } catch (error) {
          captured = error;
          throw error;
        }
      }, ContractError);
      assert.ok(captured instanceof ContractError);
      assert.equal(typeof captured.code, 'string');
      assert.ok(captured.code.length > 0);
      assert.equal(typeof captured.path, 'string');
      assert.ok(captured.path.startsWith('$'), `${captured.path} 应以 $ 开头`);
    }
  }
  expectCode(() => validateTelemetryEvent({}), 'ERR_MISSING_FIELD', '$.schemaVersion');
});

test('contracts/package.json 的元数据符合约束', () => {
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, 'packages', 'contracts', 'package.json'), 'utf8'),
  );
  assert.equal(manifest.name, '@aegisharness/contracts');
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.author, 'PT-dove');
  assert.equal(manifest.private, true);
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.devDependencies, undefined);
  assert.equal(manifest.scripts, undefined);
  assert.equal(manifest.exports['.'], './src/index.js');
});

test('源码不使用 require，也不含第三方或外部产品字样', () => {
  const files = readdirSync(SRC_ROOT, { recursive: true })
    .map((entry) => String(entry).replaceAll('\\', '/'))
    .filter((entry) => entry.endsWith('.js'));
  assert.ok(files.length >= 15);
  // 外部产品名用拼接构造，避免本文件自身出现这些字样。
  const bannedWords = ['Work' + 'Buddy', 'Ten' + 'cent', 'Code' + 'Buddy', '\u817e\u8baf'];
  for (const relativePath of files) {
    const text = readFileSync(join(SRC_ROOT, relativePath), 'utf8');
    assert.equal(/\brequire\s*\(/.test(text), false, `${relativePath} 不应使用 require`);
    for (const word of bannedWords) {
      assert.equal(text.includes(word), false, `${relativePath} 不应出现外部产品字样`);
    }
    assert.equal(/from\s+'(?!node:|\.)/.test(text), false, `${relativePath} 只允许相对路径或 node: 内置模块`);
  }
});

test('错误码表与限制表都是冻结的且键值一致', () => {
  assert.ok(Object.isFrozen(ERROR_CODES));
  assert.ok(Object.isFrozen(LIMITS));
  for (const [key, value] of Object.entries(ERROR_CODES)) {
    assert.equal(key, value);
    assert.ok(key.startsWith('ERR_'));
  }
  assert.equal(LIMITS.maxDepth, 6);
  assert.equal(LIMITS.maxMessageBytes, 1048576);
  assert.equal(LIMITS.maxRawEvidenceStringBytes, 262144);
});
