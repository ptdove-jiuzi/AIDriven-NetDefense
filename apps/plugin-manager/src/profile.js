// AegisHarness plugin manager — author: PT-dove
// Frozen compatibility profile shared with docs/design/PLUGIN_COMPATIBILITY_PROFILE.md.

export const COMPATIBILITY_PROFILE = Object.freeze({
  manifestSchemaVersion: '1.0',
  overlaySchemaVersion: '1.0',
  api: 'aegis-extension-v1',
  dsh: '0.2.2-alpha.2',
  cordis: '4.0.6-alpha.1',
  cordisPackage: '@deepseek-ai/cordis',
  nodeEngine: '>=24.9.0',
  moduleType: 'module',
  entry: 'lib/index.js',
  rpcVersion: '1.0',
  rpcMethods: Object.freeze([
    'tools.register',
    'analysis.getDto',
    'analysis.subscribe',
    'report.registerRenderer',
    'scratch.write',
    'log.write',
  ]),
  limits: Object.freeze({
    pluginJsonBytes: 65536,
    packageJsonBytes: 65536,
    sourceFileBytes: 262144,
    sourceFiles: 128,
    tools: 32,
    toolTimeoutMs: 5000,
    toolResultBytes: 65536,
    promptBytes: 4096,
    activateMs: 5000,
    disposeMs: 5000,
    rpcBytes: 65536,
  }),
});
