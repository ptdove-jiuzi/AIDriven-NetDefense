/**
 * Target normalisation: what a request is allowed to point at.
 *
 * The interesting cases are all "same object, different spelling" or "different
 * object, one spelling": traversal, device namespaces, alternate data streams,
 * reserved device names, NFD/control characters, hostnames instead of IP
 * literals, and — most importantly — a bare PID or a path string, which design
 * §10.2 forbids as an identity.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BS,
  LINUX_FILE_PATH,
  OBJECT_ID,
  OTHER_OBJECT_ID,
  WINDOWS_FILE_PATH,
  WINDOWS_IMAGE_PATH,
  linuxFileTarget,
  linuxNetworkTarget,
  linuxProcessTarget,
  windowsFileTarget,
  windowsNetworkTarget,
  windowsProcessTarget,
} from './helpers.js';
import {
  compareContractTarget,
  ensureNormalizedTarget,
  isNormalizedTarget,
  normalizeTarget,
  toContractTarget,
} from '../../packages/response-policy/index.js';

/**
 * @param {() => unknown} fn Operation expected to throw.
 * @returns {string} The `PolicyError` code, or `NO_THROW`.
 */
function codeOf(fn) {
  try {
    fn();
    return 'NO_THROW';
  } catch (error) {
    return typeof error?.code === 'string' ? error.code : `THREW:${error?.name ?? 'unknown'}`;
  }
}

/**
 * @param {object} overrides File target overrides.
 * @returns {string} Policy error code.
 */
function fileCode(overrides) {
  return codeOf(() => normalizeTarget({
    os: 'windows',
    kind: 'file',
    path: WINDOWS_FILE_PATH,
    object_id: OBJECT_ID,
    object_id_source: 'file_handle',
    ...overrides,
  }));
}

describe('target normalisation', () => {
  it('normalises a Windows path to an uppercase drive and a stable digest', () => {
    const target = windowsFileTarget();
    assert.equal(target.identity.path, WINDOWS_FILE_PATH);
    assert.match(target.digest, /^[0-9a-f]{64}$/u);
    assert.equal(isNormalizedTarget(target), true);
    assert.equal(Object.isFrozen(target), true);
    assert.equal(Object.isFrozen(target.identity), true);
  });

  it('normalises the drive-letter case of one object and nothing more', () => {
    const lowerDrive = normalizeTarget({
      os: 'windows',
      kind: 'file',
      path: `c:${BS}TestSandbox${BS}invoice.pdf`,
      object_id: OBJECT_ID,
      object_id_source: 'file_handle',
    });
    assert.equal(lowerDrive.digest, windowsFileTarget().digest);
    assert.equal(lowerDrive.identity.path, WINDOWS_FILE_PATH);

    // 段名大小写、8.3 短名都不折叠：NTFS 语义归适配器，本层宁可误拒也不猜。
    // 真正的同一性来自 object_id，而不是路径字符串。
    const upperSegment = windowsFileTarget({ path: `C:${BS}TESTSANDBOX${BS}INVOICE.PDF` });
    assert.notEqual(upperSegment.digest, windowsFileTarget().digest);
    const shortName = windowsFileTarget({ path: `C:${BS}PROGRA~1${BS}invoice.pdf` });
    assert.notEqual(shortName.digest, windowsFileTarget().digest);
  });

  it('keeps distinct objects on distinct digests', () => {
    const other = windowsFileTarget({ object_id: OTHER_OBJECT_ID });
    assert.notEqual(other.digest, windowsFileTarget().digest);
    const otherPath = windowsFileTarget({ path: `C:${BS}TestSandbox${BS}other.pdf` });
    assert.notEqual(otherPath.digest, windowsFileTarget().digest);
  });

  it('leaves a canonical POSIX path untouched', () => {
    const target = linuxFileTarget();
    assert.equal(target.identity.path, LINUX_FILE_PATH);
    assert.equal(target.os, 'linux');
    assert.equal(target.identity.source, 'parent_dir_handle');
  });

  it('rejects traversal in every separator spelling', () => {
    assert.equal(fileCode({ path: `C:${BS}TestSandbox${BS}..${BS}windows${BS}system32` }), 'DENY_TARGET_TRAVERSAL');
    assert.equal(codeOf(() => normalizeTarget({
      os: 'linux',
      kind: 'file',
      path: '/tmp/../etc/passwd',
      object_id: OBJECT_ID,
      object_id_source: 'file_handle',
    })), 'DENY_TARGET_TRAVERSAL');
    assert.equal(codeOf(() => normalizeTarget({
      os: 'linux',
      kind: 'file',
      path: '/tmp/..',
      object_id: OBJECT_ID,
      object_id_source: 'file_handle',
    })), 'DENY_TARGET_TRAVERSAL');
    // 行首的相对穿越也要归到"穿越"，不能只报"拼写不合法"。
    assert.equal(fileCode({ path: `..${BS}Windows${BS}notepad.exe` }), 'DENY_TARGET_TRAVERSAL');
    assert.equal(codeOf(() => normalizeTarget({
      os: 'linux',
      kind: 'file',
      path: '../etc/passwd',
      object_id: OBJECT_ID,
      object_id_source: 'file_handle',
    })), 'DENY_TARGET_TRAVERSAL');
  });

  it('rejects percent-encoded and mixed-separator traversal', () => {
    assert.equal(fileCode({ path: `C:${BS}TestSandbox${BS}%2e%2e${BS}secret` }), 'DENY_TARGET_NONCANONICAL');
    // 穿越必须先于分隔符报错：审计要看到"穿越"，不是"拼写不合法"。
    assert.equal(codeOf(() => normalizeTarget({
      os: 'linux',
      kind: 'file',
      path: '/tmp\\..\\etc',
      object_id: OBJECT_ID,
      object_id_source: 'file_handle',
    })), 'DENY_TARGET_TRAVERSAL');
    assert.equal(fileCode({ path: `C:${BS}TestSandbox${BS}sub/../../secret` }), 'DENY_TARGET_TRAVERSAL');
  });

  it('rejects device and UNC namespaces', () => {
    assert.equal(fileCode({ path: `${BS}${BS}?${BS}C:${BS}Windows` }), 'DENY_TARGET_DEVICE_PATH');
    assert.equal(fileCode({ path: `${BS}${BS}.${BS}C:${BS}Windows` }), 'DENY_TARGET_DEVICE_PATH');
    assert.equal(fileCode({ path: `${BS}${BS}server${BS}share${BS}file` }), 'DENY_TARGET_DEVICE_PATH');
  });

  it('rejects alternate data streams', () => {
    assert.equal(fileCode({ path: `C:${BS}TestSandbox${BS}invoice.pdf:secret` }), 'DENY_TARGET_ADS');
  });

  it('rejects reserved device basenames', () => {
    assert.equal(fileCode({ path: `C:${BS}TestSandbox${BS}CON` }), 'DENY_TARGET_RESERVED_NAME');
    assert.equal(fileCode({ path: `C:${BS}TestSandbox${BS}nul.txt` }), 'DENY_TARGET_RESERVED_NAME');
    assert.equal(fileCode({ path: `C:${BS}com1.log` }), 'DENY_TARGET_RESERVED_NAME');
    assert.equal(fileCode({ path: `C:${BS}TestSandbox${BS}CONIN$` }), 'DENY_TARGET_RESERVED_NAME');
    assert.equal(fileCode({ path: `C:${BS}TestSandbox${BS}conout$` }), 'DENY_TARGET_RESERVED_NAME');
    assert.equal(fileCode({ path: `C:${BS}TestSandbox${BS}COM\u00B9.log` }), 'DENY_TARGET_RESERVED_NAME');
  });

  it('rejects non-canonical shapes: relative, roots, trailing separators, dot segments', () => {
    assert.equal(fileCode({ path: `${BS}TestSandbox${BS}a.pdf` }), 'DENY_TARGET_NONCANONICAL');
    assert.equal(fileCode({ path: 'TestSandbox\\a.pdf' }), 'DENY_TARGET_NONCANONICAL');
    assert.equal(fileCode({ path: `C:${BS}` }), 'DENY_TARGET_NONCANONICAL');
    assert.equal(fileCode({ path: `C:${BS}TestSandbox${BS}` }), 'DENY_TARGET_NONCANONICAL');
    assert.equal(fileCode({ path: `C:${BS}TestSandbox${BS}.${BS}a.pdf` }), 'DENY_TARGET_NONCANONICAL');
    assert.equal(codeOf(() => normalizeTarget({
      os: 'linux',
      kind: 'file',
      path: '/',
      object_id: OBJECT_ID,
      object_id_source: 'file_handle',
    })), 'DENY_TARGET_NONCANONICAL');
    assert.equal(codeOf(() => normalizeTarget({
      os: 'linux',
      kind: 'file',
      path: '/tmp//a',
      object_id: OBJECT_ID,
      object_id_source: 'file_handle',
    })), 'DENY_TARGET_NONCANONICAL');
  });

  it('rejects non-NFC and control characters in a path', () => {
    assert.equal(fileCode({ path: `C:${BS}cafe\u0301.pdf` }), 'DENY_TARGET_NONCANONICAL');
    assert.equal(fileCode({ path: `C:${BS}TestSandbox${BS}a\u0007b.pdf` }), 'DENY_TARGET_NONCANONICAL');
  });

  it('rejects an oversized path before anything else', () => {
    assert.equal(fileCode({ path: `C:${BS}${'a'.repeat(5000)}` }), 'DENY_TARGET_TOO_LARGE');
  });

  it('refuses a bare PID: process identity needs a handle-derived object_id', () => {
    assert.equal(codeOf(() => normalizeTarget({
      os: 'windows',
      kind: 'process',
      image_path: WINDOWS_IMAGE_PATH,
      start_time: '2026-10-01T01:02:03Z',
      pid: 4242,
      object_id_source: 'process_handle',
    })), 'DENY_TARGET_INSUFFICIENT_IDENTITY');
    assert.equal(codeOf(() => normalizeTarget({
      os: 'windows',
      kind: 'process',
      image_path: WINDOWS_IMAGE_PATH,
      start_time: '2026-10-01T01:02:03Z',
      object_id: OBJECT_ID,
      object_id_source: 'path_string',
    })), 'DENY_TARGET_INSUFFICIENT_IDENTITY');
    assert.equal(codeOf(() => normalizeTarget({
      os: 'windows',
      kind: 'process',
      image_path: WINDOWS_IMAGE_PATH,
      start_time: '2026-10-01T01:02:03Z',
      object_id: 'short',
      object_id_source: 'process_handle',
    })), 'DENY_TARGET_INSUFFICIENT_IDENTITY');
  });

  it('requires a strict creation time and keeps pid out of the identity', () => {
    assert.equal(codeOf(() => normalizeTarget({
      os: 'windows',
      kind: 'process',
      image_path: WINDOWS_IMAGE_PATH,
      start_time: '2026-10-01 01:02:03',
      object_id: OBJECT_ID,
      object_id_source: 'process_handle',
    })), 'DENY_TARGET_NONCANONICAL');
    assert.equal(codeOf(() => normalizeTarget({
      os: 'windows',
      kind: 'process',
      image_path: WINDOWS_IMAGE_PATH,
      start_time: '2026-10-01T01:02:03Z',
      object_id: OBJECT_ID,
      object_id_source: 'process_handle',
      pid: 1.5,
    })), 'DENY_TARGET_SHAPE');
    // pid 只回显：句柄 + 创建时间才是身份，pid 会被复用，不能影响摘要。
    const withPid = windowsProcessTarget({ pid: 4242 });
    assert.equal(withPid.pid, 4242);
    assert.equal(Object.prototype.hasOwnProperty.call(withPid.identity, 'pid'), false);
    assert.equal(withPid.digest, windowsProcessTarget().digest);
    assert.equal(windowsProcessTarget().pid, null);
  });

  it('collapses the two legal spellings of one creation instant', () => {
    const plain = windowsProcessTarget({ start_time: '2026-10-01T01:02:03Z' });
    const millis = windowsProcessTarget({ start_time: '2026-10-01T01:02:03.000Z' });
    assert.equal(plain.identity.start_time, '2026-10-01T01:02:03.000Z');
    assert.equal(plain.digest, millis.digest);
  });

  it('rejects hostnames, zone ids and bracketed addresses on network targets', () => {
    assert.equal(codeOf(() => normalizeTarget({
      os: 'windows',
      kind: 'network',
      protocol: 'tcp',
      local_address: 'localhost',
      local_port: 50123,
      remote_address: '203.0.113.9',
      remote_port: 443,
      operation_id: OBJECT_ID,
    })), 'DENY_TARGET_NONCANONICAL');
    assert.equal(codeOf(() => normalizeTarget({
      os: 'linux',
      kind: 'network',
      protocol: 'tcp',
      local_address: 'fe80::1%eth0',
      local_port: 50123,
      remote_address: '203.0.113.9',
      remote_port: 443,
      operation_id: OBJECT_ID,
    })), 'DENY_TARGET_NONCANONICAL');
    assert.equal(codeOf(() => normalizeTarget({
      os: 'linux',
      kind: 'network',
      protocol: 'tcp',
      local_address: '[::1]',
      local_port: 50123,
      remote_address: '203.0.113.9',
      remote_port: 443,
      operation_id: OBJECT_ID,
    })), 'DENY_TARGET_NONCANONICAL');
  });

  it('rejects bad protocol, port range and missing operation_id on network targets', () => {
    assert.equal(codeOf(() => normalizeTarget({
      os: 'windows',
      kind: 'network',
      protocol: 'icmp',
      local_address: '10.0.0.5',
      local_port: 50123,
      remote_address: '203.0.113.9',
      remote_port: 443,
      operation_id: OBJECT_ID,
    })), 'DENY_TARGET_SHAPE');
    assert.equal(codeOf(() => normalizeTarget({
      os: 'windows',
      kind: 'network',
      protocol: 'tcp',
      local_address: '10.0.0.5',
      local_port: 70000,
      remote_address: '203.0.113.9',
      remote_port: 443,
      operation_id: OBJECT_ID,
    })), 'DENY_TARGET_SHAPE');
    assert.equal(codeOf(() => normalizeTarget({
      os: 'windows',
      kind: 'network',
      protocol: 'tcp',
      local_address: '10.0.0.5',
      local_port: 50123,
      remote_address: '203.0.113.9',
      remote_port: 443,
    })), 'DENY_TARGET_INSUFFICIENT_IDENTITY');
  });

  it('collapses IPv6 case and reports cloud-metadata style targets as ordinary tuples', () => {
    const upper = windowsNetworkTarget({ local_address: '2001:DB8::1', remote_address: '2001:DB8::2' });
    const lower = windowsNetworkTarget({ local_address: '2001:db8::1', remote_address: '2001:db8::2' });
    assert.equal(upper.digest, lower.digest);
    assert.equal(upper.identity.local_address, '2001:db8::1');
    const metadata = windowsNetworkTarget({ remote_address: '169.254.169.254', remote_port: 80 });
    assert.equal(metadata.identity.remote_address, '169.254.169.254');
  });

  it('rejects undeclared target fields', () => {
    assert.equal(fileCode({ command: 'powershell -c calc' }), 'DENY_TARGET_SHAPE');
    assert.equal(codeOf(() => normalizeTarget({
      os: 'linux',
      kind: 'network',
      protocol: 'tcp',
      local_address: '10.0.0.5',
      local_port: 50123,
      remote_address: '203.0.113.9',
      remote_port: 443,
      operation_id: OBJECT_ID,
      rule: 'iptables -F',
    })), 'DENY_TARGET_SHAPE');
  });

  it('rejects unknown OS families and unknown target kinds', () => {
    assert.equal(codeOf(() => normalizeTarget({
      os: 'darwin',
      kind: 'file',
      path: '/Users/a/b',
      object_id: OBJECT_ID,
      object_id_source: 'file_handle',
    })), 'DENY_OS_UNKNOWN');
    assert.equal(codeOf(() => normalizeTarget({
      os: 'windows',
      kind: 'registry',
      key: `HKLM${BS}Software`,
    })), 'DENY_TARGET_KIND_UNSUPPORTED');
    assert.equal(codeOf(() => normalizeTarget(null)), 'DENY_TARGET_SHAPE');
    assert.equal(codeOf(() => normalizeTarget({ os: 'windows' })), 'DENY_TARGET_KIND_UNSUPPORTED');
  });

  it('projects a normalised target onto the contracts DTO and compares round-trips', () => {
    const target = windowsProcessTarget();
    const dto = toContractTarget(target);
    assert.deepEqual(Object.keys(dto).sort(), ['digest', 'object_id', 'target_kind']);
    assert.equal(dto.target_kind, 'process');
    assert.equal(dto.digest, target.digest);
    assert.equal(dto.object_id, target.objectId);

    assert.equal(compareContractTarget(dto, target), 'match');
    assert.equal(compareContractTarget({ ...dto, target_kind: 'file' }, target), 'kind_mismatch');
    assert.equal(compareContractTarget({ ...dto, digest: 'a'.repeat(64) }, target), 'digest_mismatch');
    assert.equal(compareContractTarget({ ...dto, object_id: OTHER_OBJECT_ID }, target), 'object_mismatch');
    assert.equal(compareContractTarget(null, target), 'shape');
  });

  it('cannot be forged by spreading a normalised target', () => {
    const target = windowsProcessTarget();
    const forged = { ...target, digest: 'f'.repeat(64) };
    // 展开会复制 brand symbol，所以 brand 单独不足以证明"已规范化"；
    // 只有 normalizeTarget 实际签发的对象才被接受。
    assert.equal(isNormalizedTarget(forged), false);
    assert.equal(codeOf(() => ensureNormalizedTarget(forged)), 'DENY_TARGET_SHAPE');
    assert.equal(isNormalizedTarget(target), true);
  });

  it('keeps Linux and Windows targets for the same object distinct', () => {
    assert.notEqual(linuxFileTarget().digest, windowsFileTarget().digest);
    assert.notEqual(linuxProcessTarget().digest, windowsProcessTarget().digest);
    // The OS is part of the identity, so one connection tuple resolved on two
    // platforms must not collapse to one digest — a cross-OS plan would then be
    // indistinguishable from a local one.
    assert.notEqual(linuxNetworkTarget().digest, windowsNetworkTarget().digest);
  });
});
