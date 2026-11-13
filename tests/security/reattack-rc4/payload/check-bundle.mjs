#!/usr/bin/env node
/**
 * REATTACK-RC4 / payload-v16 · check-bundle.mjs
 *
 * 抽检 3：dist/bundle/win32-x64-v16/bundle.json 的 nonGoals / counts / prune / releaseGaps / source
 * 是否与实际载荷（文件系统）相符，且不被发布侧自证带偏。
 *
 * 检查项：
 *   BND-01 bundle.json 可解析、记录 sha256/bytes。
 *   BND-02 nonGoals 6 条齐全（不采信文本，逐条对文件系统验证）：
 *     NG-01 code signing            → PE 证书表 + Get-AuthenticodeSignature 必须“未签名”。
 *     NG-02 无自动下载/应用更新      → 无 updater 文件/模块、产品代码无更新 URL/fetch、载荷无 latest.json。
 *     NG-03 仅 win32-x64            → 桌面 exe / node.exe 的 PE Machine=0x8664；无非 win32 平台目录/动态库。
 *     NG-04 无模型权重              → 无 *.safetensors/*.gguf/*.onnx/*.pt 等；>10MB 文件逐个列出。
 *     NG-05 无 broker/sandbox-launcher 整合 → 树内无 model-broker/sandbox-launcher 路径、包名、配置引用。
 *     NG-06 无 service 注册         → apps/service-host 不在载荷；无 windows-service 包；产品代码无 CreateService/sc.exe。
 *   BND-08 counts / prune 对账：counts.packages == prune.keptPackages == ΣbyLicense；prunedNames 三处一致
 *          且 == 仓库 prune-list 条目数；prune.list.sha256 与仓库清单文件一致。
 *   BND-09 source / bundleProfile / license 声明哈希对账（仓库 package-lock.json、profile、prune-list）。
 *   BND-10 manifests/files.sha256 与磁盘递归对账：条目数 / 缺文件 / 多文件 / sha256 不一致。
 *   BND-11 console.files / rules / assets / entryForwarders / paths 声明与磁盘一致。
 *   BND-12 releaseGaps 内容检查（本载荷为空数组 → 只能确认“无声明”，并记录可验证的实际缺口）。
 *   BND-13 元数据观察（如 console.note 与 sourcePath 不一致）。
 *   BND-14 磁盘递归统计（文件数/总字节）并记录 bundle.json 是否声明该数字。
 *
 * 变异开关（只在 %TEMP% 副本上改 bundle.json，dist/** 只读）：
 *   M3  删除 nonGoals 第 1 条 → 期望 BND-02 转红（退出码 1）。
 *   M3b counts.prunedNames 由 405 改为 404 → 期望 BND-08 对账转红。
 *
 * 用法：
 *   node tests/security/reattack-rc4/payload/check-bundle.mjs
 *   node tests/security/reattack-rc4/payload/check-bundle.mjs --mutation M3
 *   node tests/security/reattack-rc4/payload/check-bundle.mjs --bundle <dir> --repo <root> --json <out.json>
 *
 * 退出码：0 = 全部 PASS/INFO；1 = 有 FAIL；2 = 参数/环境错误。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT_DEFAULT = path.resolve(__dirname, '..', '..', '..', '..');
const TEMP_ROOT = path.join(process.env.TEMP || process.env.TMP || '.', 'reattack-rc4-payload');

function parseArgs(argv) {
  const out = { bundle: null, repo: null, json: null, mutation: 'none' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--bundle') out.bundle = argv[++i];
    else if (a === '--repo') out.repo = argv[++i];
    else if (a === '--json') out.json = argv[++i];
    else if (a === '--mutation') out.mutation = argv[++i];
    else if (a === '--help' || a === '-h') { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]); process.exit(0); }
    else { console.error(`unknown arg: ${a}`); process.exit(2); }
  }
  out.repo = path.resolve(out.repo || REPO_ROOT_DEFAULT);
  out.bundle = path.resolve(out.bundle || path.join(out.repo, 'dist', 'bundle', 'win32-x64-v16'));
  return out;
}
const args = parseArgs(process.argv.slice(2));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function walk(dir) {
  const out = [];
  (function rec(d) {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      try {
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) rec(p);
        else if (e.isFile()) out.push(p);
      } catch { /* ignore */ }
    }
  })(dir);
  return out;
}

// ---------------------------------------------------------------- PE 解析（不依赖外部工具）
function parsePE(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 0x40 || buf[0] !== 0x4d || buf[1] !== 0x5a) return { isPE: false };
  const eLfanew = buf.readUInt32LE(0x3c);
  if (eLfanew + 24 > buf.length || buf.readUInt32LE(eLfanew) !== 0x00004550) return { isPE: false };
  const machine = buf.readUInt16LE(eLfanew + 4);
  const numSections = buf.readUInt16LE(eLfanew + 6);
  const optSize = buf.readUInt16LE(eLfanew + 20);
  const optStart = eLfanew + 24;
  const magic = buf.readUInt16LE(optStart);
  const dataDirStart = optStart + (magic === 0x20b ? 112 : 96);
  // Certificate Table 是 data directory 第 5 项（index 4）
  const certVA = buf.readUInt32LE(dataDirStart + 4 * 8);
  const certSize = buf.readUInt32LE(dataDirStart + 4 * 8 + 4);
  return {
    isPE: true, machine: '0x' + machine.toString(16), machineName: machine === 0x8664 ? 'x64' : machine === 0x14c ? 'x86' : machine === 0xaa64 ? 'arm64' : 'other',
    isPE32Plus: magic === 0x20b, numSections, certTableVA: certVA, certTableSize: certSize,
    signed: certVA !== 0 || certSize !== 0,
    sha256: sha256(buf), bytes: buf.length,
  };
}

function authenticode(file) {
  const cands = [
    ['pwsh', ['-NoProfile', '-NonInteractive', '-Command', `$s = Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g, "''")}'; Write-Output ("Status=" + $s.Status); Write-Output ("SignatureType=" + $s.SignatureType)`]],
    ['powershell', ['-NoProfile', '-NonInteractive', '-Command', `$s = Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g, "''")}'; Write-Output ("Status=" + $s.Status); Write-Output ("SignatureType=" + $s.SignatureType)`]],
  ];
  for (const [exe, argv] of cands) {
    try {
      const out = execFileSync(exe, argv, { encoding: 'utf8', timeout: 60000, windowsHide: true });
      const status = (out.match(/Status=(\w+)/) || [])[1] || 'UNKNOWN';
      const type = (out.match(/SignatureType=(\w+)/) || [])[1] || 'UNKNOWN';
      return { tool: exe, status, type, raw: out.trim() };
    } catch { /* try next */ }
  }
  return { tool: null, status: 'UNAVAILABLE', type: 'UNAVAILABLE', raw: '' };
}

// ---------------------------------------------------------------- 收集
const bundleRoot = args.bundle;
const bundleJsonPath = path.join(bundleRoot, 'bundle.json');
const results = [];
function record(id, check, status, detail) { results.push({ id, check, status, detail }); console.log(`[${status}] ${id} · ${check} · ${detail}`); }

console.log('='.repeat(78));
console.log('REATTACK-RC4 payload-v16 · check-bundle.mjs');
console.log(`bundle = ${bundleRoot}`);
console.log(`repo   = ${args.repo}`);
console.log(`mutation = ${args.mutation}`);
console.log(`time   = ${new Date().toISOString()}`);
console.log('='.repeat(78));

if (!fs.existsSync(bundleJsonPath)) { console.error(`bundle.json 不存在：${bundleJsonPath}`); process.exit(2); }

// 变异 M3/M3b：复制 bundle.json 到 %TEMP% 再改（dist 只读）
let mutationInfo = null;
let jsonPath = bundleJsonPath;
if (args.mutation !== 'none') {
  if (!['M3', 'M3b'].includes(args.mutation)) { console.error(`未知 mutation: ${args.mutation}`); process.exit(2); }
  const mutRoot = path.join(TEMP_ROOT, 'mut', args.mutation);
  fs.rmSync(mutRoot, { recursive: true, force: true });
  fs.mkdirSync(mutRoot, { recursive: true });
  const mutJsonPath = path.join(mutRoot, 'bundle.json');
  fs.copyFileSync(bundleJsonPath, mutJsonPath);
  const j = JSON.parse(fs.readFileSync(mutJsonPath, 'utf8'));
  mutationInfo = { kind: args.mutation, mutJsonPath, bundleSrcSha256: sha256(fs.readFileSync(bundleJsonPath)), actions: [] };
  if (args.mutation === 'M3') {
    const removed = j.nonGoals.shift();
    mutationInfo.actions.push(`删除 nonGoals[0]: "${removed}"；剩余 ${j.nonGoals.length} 条`);
  } else {
    mutationInfo.actions.push(`counts.prunedNames: ${j.counts.prunedNames} -> 404`);
    j.counts.prunedNames = 404;
  }
  fs.writeFileSync(mutJsonPath, JSON.stringify(j, null, 2));
  mutationInfo.mutJsonSha256 = sha256(fs.readFileSync(mutJsonPath));
  jsonPath = mutJsonPath;
  console.log(`[MUTATION ${args.mutation}] ${JSON.stringify(mutationInfo)}`);
}

const jsonBuf = fs.readFileSync(jsonPath);
const bundle = JSON.parse(jsonBuf.toString('utf8'));
const jsonSha256 = sha256(jsonBuf);
record('BND-01', 'bundle.json 可解析且记录指纹', 'PASS', `bytes=${jsonBuf.length} sha256=${jsonSha256}${mutationInfo ? '（变异副本）' : ''}`);

// ---------------------------------------------------------------- BND-02 nonGoals
const EXPECTED_NONGOALS = [
  { id: 'NG-01', name: 'code signing', re: /code\s*signing/i },
  { id: 'NG-02', name: 'automatic download/apply of an update', re: /automatic[^]*update|auto[^]*update/i },
  { id: 'NG-03', name: 'four-OS packaging (win32-x64 only)', re: /win32-x64\s*only|four[- ]os/i },
  { id: 'NG-04', name: 'model weights', re: /model\s*weights/i },
  { id: 'NG-05', name: 'broker / sandbox-launcher integration', re: /broker[^]*sandbox[- ]launcher/i },
  { id: 'NG-06', name: 'service registration', re: /service\s*registration/i },
];
const nonGoals = Array.isArray(bundle.nonGoals) ? bundle.nonGoals : [];
console.log(`[INFO] bundle.json nonGoals (${nonGoals.length} 条)：`);
nonGoals.forEach((g, i) => console.log(`   [${i}] ${g}`));
const ngPresent = EXPECTED_NONGOALS.map((e) => ({ ...e, present: nonGoals.some((g) => e.re.test(g)) }));
const ngMissing = ngPresent.filter((e) => !e.present);
checkNonGoals: {
  if (ngMissing.length > 0) {
    record('BND-02', `nonGoals 6 条齐全（实际 ${nonGoals.length}）`, 'FAIL',
      `缺少：${ngMissing.map((e) => e.id + ':' + e.name).join(' | ')}；实际列表=${JSON.stringify(nonGoals)}`);
  } else if (nonGoals.length !== 6) {
    record('BND-02', 'nonGoals 6 条齐全', 'FAIL', `6 条语义齐全但条数=${nonGoals.length}`);
  } else {
    record('BND-02', 'nonGoals 6 条齐全', 'PASS', `逐条匹配：${ngPresent.map((e) => e.id).join(',')}`);
  }
}

// NG-01 code signing
const exePath = path.join(bundleRoot, 'AIDrivenNetDefense.exe');
const exePE = fs.existsSync(exePath) ? parsePE(exePath) : null;
const exeSig = fs.existsSync(exePath) ? authenticode(exePath) : null;
const sigFiles = walk(bundleRoot).filter((p) => /\.(sig|p7b|p7s|cer|pfx|p12)$/i.test(p));
console.log(`[INFO] NG-01 AIDrivenNetDefense.exe PE: ${JSON.stringify(exePE)}`);
console.log(`[INFO] NG-01 Get-AuthenticodeSignature: ${JSON.stringify(exeSig)}`);
record('NG-01', 'nonGoal "code signing"：载荷未做代码签名，与声明相符',
  exePE && !exePE.signed && exeSig && /NotSigned|Unavailable/i.test(exeSig.status) && sigFiles.length === 0 ? 'PASS' : 'FAIL',
  `certTableVA=${exePE ? exePE.certTableVA : 'n/a'} certTableSize=${exePE ? exePE.certTableSize : 'n/a'}；Authenticode=${exeSig ? exeSig.status + '/' + exeSig.type : 'n/a'}；签名类文件=${sigFiles.length}`);

// NG-01b 发布层：rc.4 Setup.exe 也未签名（非Goal声明通常在发布说明层复核）
const setupPath = path.join(args.repo, 'dist', 'release', '0.0.1-rc.4', 'AIDrivenNetDefense-Setup-0.0.1-rc.4.exe');
let setupSig = null;
let setupInfo = null;
if (fs.existsSync(setupPath)) {
  setupInfo = { path: path.relative(args.repo, setupPath).replace(/\\/g, '/'), bytes: fs.statSync(setupPath).size, sha256: sha256(fs.readFileSync(setupPath)) };
  setupSig = authenticode(setupPath);
  console.log(`[INFO] NG-01b Setup.exe ${JSON.stringify(setupInfo)} Authenticode=${JSON.stringify(setupSig)}`);
}
record('NG-01b', 'rc.4 Setup.exe 亦未签名（发布层一致）', setupSig ? (/NotSigned/i.test(setupSig.status) ? 'PASS' : 'FAIL') : 'INFO',
  setupSig ? `Status=${setupSig.status}/${setupSig.type}；bytes=${setupInfo.bytes}；sha256=${setupInfo.sha256}` : 'Setup.exe 不存在，跳过');

// NG-02 auto update
const UPD_FILE_RE = /(^|[\\/])(updater|auto-?update|update[-_]?service|squirrel|electron[-_]?updater)([\\/.]|$)|\.(nupkg|update)$/i;
const UPD_CONTENT_RE = /(autoUpdater|electron-updater|checkForUpdates|downloadUpdate|updateUrl|updateServer|latest\.json|automatic\w*\s+(download|update))/i;
const updateUrlRe = /https?:\/\/[^\s"'<>]*(?:update|release|latest)[^\s"'<>]*/i;
const allFiles = walk(bundleRoot);
const updNameHits = allFiles.filter((p) => UPD_FILE_RE.test(path.relative(bundleRoot, p)));
const productFiles = allFiles.filter((p) => {
  const rel = path.relative(bundleRoot, p).replace(/\\/g, '/');
  return /^(console|launch|launcher|apps|dsh-home|rules)\//.test(rel) || rel === 'README-BUNDLE.md';
});
const updContentHits = [];
const updUrlHits = [];
for (const f of productFiles) {
  let buf;
  try { buf = fs.readFileSync(f); } catch { continue; }
  if (buf.subarray(0, 8192).includes(0)) continue;
  const text = buf.toString('utf8');
  text.split(/\r?\n/).forEach((ln, i) => {
    if (UPD_CONTENT_RE.test(ln) || updateUrlRe.test(ln)) {
      const rel = path.relative(bundleRoot, f).replace(/\\/g, '/');
      updContentHits.push({ file: rel, line: i + 1, text: ln.trim().slice(0, 220), url: updateUrlRe.test(ln) });
    }
  });
}
for (const h of updContentHits) console.log(`[INFO] NG-02 update 相关行 ${h.file}:${h.line}${h.url ? ' [URL]' : ''} :: ${h.text}`);
const latestJsonInPayload = allFiles.filter((p) => /(^|[\\/])latest\.json$/i.test(p));
const updaterModules = allFiles.filter((p) => /[\\/](updater|electron-updater|squirrel)[\\/]|[\\/]auto-updater/i.test(path.relative(bundleRoot, p)));
const updUrlOnly = updContentHits.filter((h) => h.url);
record('NG-02', 'nonGoal "automatic download/apply of an update"：载荷内无更新器/更新下载',
  updNameHits.length === 0 && updUrlOnly.length === 0 && latestJsonInPayload.length === 0 && updaterModules.length === 0 ? 'PASS' : 'FAIL',
  `updater 命名文件=${updNameHits.length}；updater 模块目录=${updaterModules.length}；含更新 URL 的产品代码行=${updUrlOnly.length}；update 关键词行（含注释/UI 文案）=${updContentHits.length}（逐行列于上）；载荷内 latest.json=${latestJsonInPayload.length}`);
if (updNameHits.length) for (const p of updNameHits.slice(0, 20)) console.log(`   UPD-FILE ${path.relative(bundleRoot, p)}`);
if (updUrlOnly.length) for (const h of updUrlOnly.slice(0, 20)) console.log(`   UPD-URL ${h.file}:${h.line} :: ${h.text}`);

// NG-03 win32-x64 only
const nodeExe = path.join(bundleRoot, 'runtime', 'node', 'node.exe');
const nodePE = fs.existsSync(nodeExe) ? parsePE(nodeExe) : null;
const runtimeDirs = fs.existsSync(path.join(bundleRoot, 'runtime')) ? fs.readdirSync(path.join(bundleRoot, 'runtime'), { withFileTypes: true }) : [];
const otherPlatformArtifacts = allFiles.filter((p) => {
  const rel = path.relative(bundleRoot, p).replace(/\\/g, '/');
  if (/\.(d\.ts|js|mjs|cjs|ts|tsx|json|md|map|txt|yml|yaml|css|html)$/i.test(rel)) return false; // 源码/文本命名，不是原生产物
  return /[\\/](darwin|linux|freebsd|openbsd|sunos|android|ios)([\\/]|-)/i.test(rel)
    || /[\\/]win32-(arm64|ia32)([\\/]|-)/i.test(rel)
    || /\.(dylib|so)(\.\d+)*$/i.test(rel);
});
const otherPlatformBytes = otherPlatformArtifacts.reduce((a, p) => a + fs.statSync(p).size, 0);
const otherOsFamilies = [...new Set(otherPlatformArtifacts.map((p) => (path.relative(bundleRoot, p).match(/(darwin|linux|freebsd|openbsd|sunos|android|ios|win32-arm64|win32-ia32)/i) || [])[0]).filter(Boolean))];
const runtimeJsonPath = path.join(bundleRoot, 'runtime', 'node', 'runtime.json');
let runtimeJson = null;
if (fs.existsSync(runtimeJsonPath)) { try { runtimeJson = JSON.parse(fs.readFileSync(runtimeJsonPath, 'utf8')); } catch { runtimeJson = null; } }
console.log(`[INFO] NG-03 node.exe PE: ${JSON.stringify(nodePE)}`);
console.log(`[INFO] NG-03 runtime/ 顶层：${runtimeDirs.map((d) => d.name).join(',')}；runtime.json.version=${runtimeJson ? runtimeJson.version : 'n/a'}`);
for (const p of otherPlatformArtifacts.slice(0, 30)) console.log(`[INFO] NG-03 non-x64 产物：${path.relative(bundleRoot, p)} (${fs.statSync(p).size}B)`);
record('NG-03', 'nonGoal "four-OS packaging (this payload is win32-x64 only)"：载荷仅含 win32-x64',
  exePE && exePE.machineName === 'x64' && nodePE && nodePE.machineName === 'x64' && otherPlatformArtifacts.length === 0 ? 'PASS' : 'FAIL',
  `桌面 exe Machine=${exePE ? exePE.machineName : 'n/a'}；node.exe Machine=${nodePE ? nodePE.machineName : 'n/a'}；runtime 目录=[${runtimeDirs.map((d) => d.name).join(',')}]；**非 win32-x64 原生产物=${otherPlatformArtifacts.length} 个 / ${otherPlatformBytes} B，平台族=${JSON.stringify(otherOsFamilies)}**（详见上行路径）`);
if (otherPlatformArtifacts.length > 0) {
  console.log(`[INFO] NG-03 判定说明：主程序/运行时均为 x64；上述非 x64 文件全部来自依赖 app/node_modules/node-pty/prebuilds/{{darwin,linux,win32-arm64}}，在 win32-x64 上不会被加载，但使“payload is win32-x64 only”的字面表述不成立。`);
}


// NG-04 model weights
const WEIGHT_EXT_RE = /\.(safetensors|gguf|ggml|onnx|pt|pth|ckpt|h5|tflite|mlmodel|npz|bin)$/i;
const weightFiles = allFiles.filter((p) => WEIGHT_EXT_RE.test(p));
const largeFiles = allFiles.map((p) => ({ rel: path.relative(bundleRoot, p).replace(/\\/g, '/'), bytes: fs.statSync(p).size })).filter((x) => x.bytes > 10 * 1024 * 1024).sort((a, b) => b.bytes - a.bytes);
console.log(`[INFO] NG-04 权重扩展名文件=${weightFiles.length}；>10MB 文件：${largeFiles.map((x) => `${x.rel}(${x.bytes}B)`).join(' , ')}`);
record('NG-04', 'nonGoal "model weights"：载荷不含模型权重',
  weightFiles.length === 0 && largeFiles.every((x) => /^(runtime\/node\/node\.exe|AIDrivenNetDefense\.exe)$/.test(x.rel)) ? 'PASS' : 'FAIL',
  `权重扩展名文件=${weightFiles.length}；>10MB 文件=${largeFiles.length}（${largeFiles.map((x) => x.rel + ' ' + x.bytes).join('; ')}）`);
for (const p of weightFiles.slice(0, 20)) console.log(`   WEIGHT ${path.relative(bundleRoot, p)}`);

// NG-05 broker / sandbox-launcher
const brokerPathHits = allFiles.filter((p) => /model-broker|sandbox-launcher|sandbox_launcher|sandboxlauncher/i.test(path.relative(bundleRoot, p)));
const brokerContentHits = [];
const brokerDeclLines = [];
for (const f of productFiles) {
  let buf;
  try { buf = fs.readFileSync(f); } catch { continue; }
  if (buf.subarray(0, 8192).includes(0)) continue;
  const text = buf.toString('utf8');
  text.split(/\r?\n/).forEach((ln, i) => {
    if (!/model-broker|sandbox-launcher/i.test(ln)) return;
    const rec = { file: path.relative(bundleRoot, f).replace(/\\/g, '/'), line: i + 1, text: ln.trim().slice(0, 220) };
    // 排除“声明 nonGoal 本身”的行（例如 launch-plan.json 的 nonGoals 数组、README 的说明），它们不是“整合”
    if (/sandbox-launcher integration/i.test(ln) || /(no|没有|不在|not in this payload).{0,40}(broker|sandbox)/i.test(ln) || /nonGoal/i.test(ln)) brokerDeclLines.push(rec);
    else brokerContentHits.push(rec);
  });
}
for (const h of brokerDeclLines) console.log(`[INFO] NG-05 声明行（nonGoal 文本，非整合）：${h.file}:${h.line} :: ${h.text}`);
for (const h of brokerContentHits.slice(0, 30)) console.log(`[INFO] NG-05 引用行：${h.file}:${h.line} :: ${h.text}`);
record('NG-05', 'nonGoal "broker / sandbox-launcher integration"：载荷无 broker / sandbox-launcher',
  brokerPathHits.length === 0 && brokerContentHits.length === 0 ? 'PASS' : 'FAIL',
  `路径命中=${brokerPathHits.length}；实质引用=${brokerContentHits.length}；nonGoal 声明文本行（豁免）=${brokerDeclLines.length}`);

// NG-06 service registration
const serviceHostPaths = allFiles.filter((p) => /service-host|service_host/i.test(path.relative(bundleRoot, p)));
const servicePkgRe = /(^|[\\/])node_modules[\\/](node-windows|node-windows-service|winser|qckwinsvc|service-runner)([\\/]|$)/i;
const servicePkgHits = allFiles.filter((p) => servicePkgRe.test(path.relative(bundleRoot, p)));
const SERVICE_CODE_RE = /(sc\.exe\s+create|New-Service|CreateService\s*\(|ServiceInstaller|installService|--service-install)/i;
const serviceContentHits = [];
for (const f of productFiles) {
  let buf;
  try { buf = fs.readFileSync(f); } catch { continue; }
  if (buf.subarray(0, 8192).includes(0)) continue;
  const text = buf.toString('utf8');
  text.split(/\r?\n/).forEach((ln, i) => { if (SERVICE_CODE_RE.test(ln)) serviceContentHits.push({ file: path.relative(bundleRoot, f).replace(/\\/g, '/'), line: i + 1, text: ln.trim().slice(0, 200) }); });
}
const appsDir = path.join(bundleRoot, 'apps');
const appsEntries = fs.existsSync(appsDir) ? walk(appsDir).map((p) => path.relative(bundleRoot, p).replace(/\\/g, '/')) : [];
console.log(`[INFO] NG-06 apps/ 内容：${appsEntries.join(', ')}`);
record('NG-06', 'nonGoal "service registration"：载荷无 service-host、无服务注册代码',
  serviceHostPaths.length === 0 && servicePkgHits.length === 0 && serviceContentHits.length === 0 && !appsEntries.some((p) => /service-host/.test(p)) ? 'PASS' : 'FAIL',
  `service-host 路径=${serviceHostPaths.length}；windows-service 包=${servicePkgHits.length}；服务注册代码行=${serviceContentHits.length}；apps/=${appsEntries.join(',')}`);

// ---------------------------------------------------------------- BND-08 counts / prune
const pruneListRepoPath = path.resolve(args.repo, bundle.prune && bundle.prune.list ? bundle.prune.list.path : '');
let pruneRepoSha = null, pruneRepoEntries = null, pruneRepoPackages = null;
if (fs.existsSync(pruneListRepoPath)) {
  const pb = fs.readFileSync(pruneListRepoPath);
  pruneRepoSha = sha256(pb);
  try {
    const pj = JSON.parse(pb.toString('utf8'));
    pruneRepoEntries = Array.isArray(pj) ? pj.length : null;
    pruneRepoPackages = Array.isArray(pj.packages) ? pj.packages.length : null;
  } catch { /* ignore */ }
}
const byLicenseSum = bundle.counts && bundle.counts.byLicense ? Object.values(bundle.counts.byLicense).reduce((a, b) => a + b, 0) : null;
const gateClosure = bundle.prune && bundle.prune.gate && bundle.prune.gate.closurePackages;
const prunedNodes = bundle.prune && bundle.prune.prunedNodes;
// 磁盘可验证口径：app/node_modules 下唯一 name@version 数（与 closure 口径不同，仅作差异披露）
let diskUniquePackages = null, diskPackageJsonFiles = null;
const nmRoot = path.join(bundleRoot, 'app', 'node_modules');
if (fs.existsSync(nmRoot)) {
  const pjs = allFiles.filter((p) => /[\\/]app[\\/]node_modules[\\/].*package\.json$/.test(p));
  diskPackageJsonFiles = pjs.length;
  const seen = new Map();
  for (const p of pjs) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (j.name) { if (!seen.has(j.name)) seen.set(j.name, new Set()); seen.get(j.name).add(j.version); }
    } catch { /* ignore */ }
  }
  diskUniquePackages = [...seen.values()].reduce((a, s) => a + s.size, 0);
}
const countsDetail = `counts.packages=${bundle.counts && bundle.counts.packages}；ΣbyLicense=${byLicenseSum}；prune.keptPackages=${bundle.prune && bundle.prune.keptPackages}；gate.closurePackages=${gateClosure}；prune.prunedNodes=${prunedNodes}；内算 closure-prunedNodes=${typeof gateClosure === 'number' && typeof prunedNodes === 'number' ? gateClosure - prunedNodes : 'n/a'}；counts.prunedNames=${bundle.counts && bundle.counts.prunedNames}；prune.prunedNames=${bundle.prune && bundle.prune.prunedNames}；prune.list.entries=${bundle.prune && bundle.prune.list && bundle.prune.list.entries}；仓库 prune-list sha=${pruneRepoSha}（声明 ${bundle.prune && bundle.prune.list && bundle.prune.list.sha256}）；仓库 packages 条目=${pruneRepoPackages}`;
console.log(`[INFO] BND-08 ${countsDetail}`);
const countsOk =
  bundle.counts && bundle.counts.packages === 245 &&
  byLicenseSum === 245 &&
  bundle.prune && bundle.prune.keptPackages === 245 &&
  gateClosure - prunedNodes === 245 &&
  bundle.source && bundle.source.closurePackages === gateClosure &&
  bundle.counts.prunedNames === bundle.prune.prunedNames &&
  bundle.prune.prunedNames === bundle.prune.list.entries &&
  bundle.prune.list.sha256 === pruneRepoSha &&
  (pruneRepoPackages === null || pruneRepoPackages === bundle.prune.list.entries);
record('BND-08', 'counts / prune 三处一致且与仓库 prune-list 相符', countsOk ? 'PASS' : 'FAIL', countsDetail);
console.log(`[INFO] BND-08b 磁盘口径披露：app/node_modules 下 package.json=${diskPackageJsonFiles} 个，唯一 name@version=${diskUniquePackages}（声明 counts.packages=${bundle.counts && bundle.counts.packages}，与其闭包口径 658-413=245 不同；bundle.json 未写明该字段计数口径）`);
record('BND-08b', 'counts.packages 与磁盘唯一包数口径差异披露', 'INFO',
  `声明=${bundle.counts && bundle.counts.packages}；磁盘 app/node_modules 唯一 name@version=${diskUniquePackages}；差=${typeof bundle.counts.packages === 'number' && typeof diskUniquePackages === 'number' ? bundle.counts.packages - diskUniquePackages : 'n/a'}（JSON 内 658-413=245 自洽；字段未定义口径）`);

// ---------------------------------------------------------------- BND-09 source/profile/license 声明
const claims = [];
function claim(name, declared, depotRel, extraCheck) {
  const p = path.resolve(args.repo, depotRel);
  let actual = null, bytes = null;
  if (fs.existsSync(p)) { const b = fs.readFileSync(p); actual = sha256(b); bytes = b.length; }
  const ok = actual !== null && actual === declared;
  claims.push({ name, declared, actual, ok, depotRel, bytes });
  return ok;
}
const srcOk = claim('source.lockfileSha256', bundle.source && bundle.source.lockfileSha256, 'package-lock.json');
const profOk = claim('bundleProfile.sha256', bundle.bundleProfile && bundle.bundleProfile.sha256, bundle.bundleProfile && bundle.bundleProfile.document);
const licOk = claim('license.node.licenseTextSha256', bundle.license && bundle.license.node && bundle.license.node.licenseTextSha256, 'dist/bundle/win32-x64-v16/runtime/node/LICENSE-NODE.txt');
const licAttOk = claim('license.attestationsSha256', bundle.license && bundle.license.attestationsSha256, 'dist/bundle/win32-x64-v16/manifests/license-attestations.json');
for (const c of claims) console.log(`[INFO] BND-09 ${c.name}: declared=${c.declared} actual=${c.actual} ok=${c.ok} file=${c.depotRel}`);
record('BND-09', 'source / bundleProfile / license 声明的 sha256 与仓库文件一致', srcOk && profOk && licOk && licAttOk ? 'PASS' : 'FAIL',
  claims.map((c) => `${c.name}=${c.ok}`).join('；'));

// ---------------------------------------------------------------- BND-10 manifests/files.sha256 对账
const manifestRel = 'manifests/files.sha256';
const manifestPath = path.join(bundleRoot, manifestRel);
let manifestCheck = { entries: 0, missing: [], extra: [], mismatch: [] };
if (fs.existsSync(manifestPath)) {
  const lines = fs.readFileSync(manifestPath, 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
  const seen = new Set();
  // 大文件只做一次 sha，避免重复读
  for (const l of lines) {
    const m = l.match(/^([0-9a-f]{64})\s+(.+)$/);
    if (!m) continue;
    manifestCheck.entries++;
    const rel = m[2];
    seen.add(rel);
    const p = path.join(bundleRoot, rel.split('/').join(path.sep));
    if (!fs.existsSync(p)) { manifestCheck.missing.push(rel); continue; }
    const actual = sha256(fs.readFileSync(p));
    if (actual !== m[1]) manifestCheck.mismatch.push({ rel, declared: m[1], actual });
  }
  // 磁盘上应有、但清单未列的文件（排除 manifests/ 自身与清单声明的排除口径）
  const diskAll = allFiles.map((p) => path.relative(bundleRoot, p).replace(/\\/g, '/'));
  for (const rel of diskAll) {
    if (rel.startsWith('manifests/')) continue;
    if (!seen.has(rel)) manifestCheck.extra.push(rel);
  }
  const ok = manifestCheck.missing.length === 0 && manifestCheck.extra.length === 0 && manifestCheck.mismatch.length === 0;
  record('BND-10', 'manifests/files.sha256 与磁盘递归对账', ok ? 'PASS' : 'FAIL',
    `清单条目=${manifestCheck.entries}；磁盘文件（除 manifests/）=${diskAll.filter((r) => !r.startsWith('manifests/')).length}；缺失=${manifestCheck.missing.length}；清单未覆盖=${manifestCheck.extra.length}；sha256 不一致=${manifestCheck.mismatch.length}`);
  for (const x of manifestCheck.missing.slice(0, 20)) console.log(`   MANIFEST-MISSING ${x}`);
  for (const x of manifestCheck.extra.slice(0, 20)) console.log(`   DISK-EXTRA ${x}`);
  for (const x of manifestCheck.mismatch.slice(0, 20)) console.log(`   SHA-MISMATCH ${x.rel} declared=${x.declared} actual=${x.actual}`);
} else {
  record('BND-10', 'manifests/files.sha256 存在', 'FAIL', '未找到清单');
}

// ---------------------------------------------------------------- BND-11 其它声明
const declIssues = [];
function fileClaim(name, rel, declSha, declBytes) {
  const p = path.join(bundleRoot, (rel || '').split('/').join(path.sep));
  if (!rel || !fs.existsSync(p)) { declIssues.push(`${name}: 文件不存在 ${rel}`); return; }
  const b = fs.readFileSync(p);
  if (declSha && sha256(b) !== declSha) declIssues.push(`${name}: sha256 不符 declared=${declSha} actual=${sha256(b)}`);
  if (declBytes != null && b.length !== declBytes) declIssues.push(`${name}: bytes 不符 declared=${declBytes} actual=${b.length}`);
}
for (const c of bundle.console && bundle.console.files ? bundle.console.files : []) fileClaim(`console ${c.path}`, c.path, c.sha256, null);
for (const r of bundle.rules && bundle.rules.packs ? bundle.rules.packs : []) fileClaim(`rules ${r.path}`, r.path, r.sha256, null);
if (bundle.assets && bundle.assets.desktop) fileClaim('assets.desktop', bundle.assets.desktop.target, bundle.assets.desktop.sha256, bundle.assets.desktop.bytes);
if (bundle.entryForwarders) {
  const fwds = Array.isArray(bundle.entryForwarders) ? bundle.entryForwarders : [bundle.entryForwarders];
  for (const fw of fwds) fileClaim(`entryForwarder ${fw && fw.path}`, fw && fw.path, fw && fw.sha256, null);
}
const pathMap = bundle.paths || {};
const pathMissing = Object.entries(pathMap).filter(([k, rel]) => { const p = path.join(bundleRoot, String(rel)); return !fs.existsSync(p); });
for (const [k, rel] of pathMissing) declIssues.push(`paths.${k} 不存在: ${rel}`);
// console.sourcePath 声明 vs 实际产物
const consoleSourceDeclared = bundle.console && bundle.console.sourcePath;
const consoleNote = bundle.console && bundle.console.note;
console.log(`[INFO] BND-11 console.sourcePath=${consoleSourceDeclared}；console.note="${consoleNote}"；console.files=${bundle.console && bundle.console.files ? bundle.console.files.length : 'n/a'}`);
record('BND-11', 'console/rules/assets/entryForwarders/paths 声明与磁盘一致', declIssues.length === 0 ? 'PASS' : 'FAIL',
  declIssues.length === 0 ? `console.files=${bundle.console.files.length}；paths=${Object.keys(pathMap).length}；全部指向存在的文件且 sha256 一致` : declIssues.slice(0, 10).join(' | '));

// ---------------------------------------------------------------- BND-12 releaseGaps
const gaps = Array.isArray(bundle.releaseGaps) ? bundle.releaseGaps : null;
if (gaps === null) record('BND-12', 'releaseGaps 字段类型', 'FAIL', `不是数组：${typeof bundle.releaseGaps}`);
else if (gaps.length === 0) record('BND-12', 'releaseGaps 为空（无声明缺口）', 'INFO', '空数组：无可逐条对账的内容；本次抽检自身发现的实际缺口见 REPORT §3（code signing 属 nonGoal 非 gap）');
else record('BND-12', 'releaseGaps 逐条对账', 'INFO', `${gaps.length} 条，内容=${JSON.stringify(gaps).slice(0, 1500)}`);

// ---------------------------------------------------------------- BND-13 元数据观察
const metaObservations = [];
if (consoleSourceDeclared && consoleNote && /apps\/console\b/.test(consoleNote) && !/console-next/.test(consoleNote)) {
  metaObservations.push(`console.note="${consoleNote}" 与实际 sourcePath="${consoleSourceDeclared}" 不符（note 仍写 apps/console，疑似 v15 文案残留）`);
}
if (bundle.console && bundle.console.preferredSourceFiles != null && bundle.console.files && bundle.console.preferredSourceFiles !== bundle.console.files.length) {
  metaObservations.push(`console.preferredSourceFiles=${bundle.console.preferredSourceFiles} 与 console.files.length=${bundle.console.files.length} 不符`);
}
if (bundle.host && bundle.host.node && bundle.bundledNode && bundle.host.node !== bundle.bundledNode) {
  metaObservations.push(`host.node=${bundle.host.node} 与 bundledNode=${bundle.bundledNode} 不符`);
}
for (const o of metaObservations) console.log(`[INFO] BND-13 元数据观察：${o}`);
record('BND-13', 'bundle.json 元数据观察（不阻断 nonGoals）', metaObservations.length === 0 ? 'PASS' : 'INFO',
  metaObservations.length === 0 ? '无异常' : `${metaObservations.length} 条：${metaObservations.join(' | ')}`);

// ---------------------------------------------------------------- BND-14 磁盘统计
let totalFiles = 0, totalBytes = 0;
for (const p of allFiles) { totalFiles++; totalBytes += fs.statSync(p).size; }
console.log(`[INFO] BND-14 磁盘递归统计：files=${totalFiles} bytes=${totalBytes}`);
record('BND-14', '磁盘递归统计（bundle.json 未声明总文件数/总字节，记录以供对账）', 'INFO',
  `files=${totalFiles} bytes=${totalBytes}；bundle.json 顶层键=${Object.keys(bundle).join(',')}`);

// ---------------------------------------------------------------- 结论
const fails = results.filter((r) => r.status === 'FAIL');
let mutationVerdict = null;
if (args.mutation !== 'none') {
  mutationVerdict = fails.length > 0 ? 'MUTATION_DETECTED (对账转红 → 判据有效)' : 'MUTATION_NOT_DETECTED (未转红 → 判据无效)';
  console.log(`MUTATION VERDICT: ${args.mutation} -> ${mutationVerdict}`);
}
console.log('-'.repeat(78));
console.log(`SUMMARY: PASS=${results.filter((r) => r.status === 'PASS').length} FAIL=${fails.length} INFO=${results.filter((r) => r.status === 'INFO').length}`);
const exitCode = fails.length > 0 ? 1 : 0;
const payload = {
  tool: 'check-bundle.mjs', version: '1.0', generatedAt: new Date().toISOString(),
  bundle: bundleRoot, repo: args.repo, mutation: args.mutation, mutationInfo, mutationVerdict,
  bundleJson: { path: jsonPath, sha256: jsonSha256, bytes: jsonBuf.length },
  disk: { files: totalFiles, bytes: totalBytes },
  nonGoals: { declared: nonGoals, expected: ngPresent },
  checks: { ng: { exePE, exeSig, setupSig, setupInfo, sigFiles: sigFiles.length, updNameHits: updNameHits.map((p) => path.relative(bundleRoot, p)), updaterModules: updaterModules.map((p) => path.relative(bundleRoot, p)), updContentHits, latestJsonInPayload: latestJsonInPayload.map((p) => path.relative(bundleRoot, p)), nodePE, runtimeJson, otherPlatformArtifacts: otherPlatformArtifacts.map((p) => ({ path: path.relative(bundleRoot, p), bytes: fs.statSync(p).size })), otherPlatformBytes, otherOsFamilies, weightFiles: weightFiles.map((p) => path.relative(bundleRoot, p)), largeFiles, brokerPathHits: brokerPathHits.map((p) => path.relative(bundleRoot, p)), brokerContentHits, brokerDeclLines, serviceHostPaths: serviceHostPaths.map((p) => path.relative(bundleRoot, p)), servicePkgHits: servicePkgHits.map((p) => path.relative(bundleRoot, p)), serviceContentHits, appsEntries },
    counts: { byLicenseSum, countsOk, pruneRepoPath: pruneListRepoPath, pruneRepoSha, pruneRepoEntries, pruneRepoPackages, diskUniquePackages, diskPackageJsonFiles, gateClosure, prunedNodes },
    claims, manifest: { ...manifestCheck, missing: manifestCheck.missing, extra: manifestCheck.extra, mismatch: manifestCheck.mismatch },
    declIssues, metaObservations,
  },
  results, exitCode,
};
if (args.json) {
  fs.mkdirSync(path.dirname(path.resolve(args.json)), { recursive: true });
  fs.writeFileSync(path.resolve(args.json), JSON.stringify(payload, null, 2));
  console.log(`JSON -> ${path.resolve(args.json)}`);
}
process.exit(exitCode);
