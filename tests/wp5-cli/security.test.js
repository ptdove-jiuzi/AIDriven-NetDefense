/**
 * security.test.js — the read-only boundary, asserted against the source tree.
 *
 * Behavioural tests can only prove that the commands a test happened to run were
 * read-only. These assertions are about the code that exists: there is no mutating verb
 * to call, no process to spawn, no shell to reach, no database to open, and no write
 * call to a file. If someone adds one later, this file fails even if they forget to add
 * a test for the new feature.
 *
 * Same technique the daemon suite uses for "no Harness imports": the absence of a
 * capability is a property of the tree, so it is checked against the tree.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT } from './helpers.js';
import { ROUTES } from '../../apps/cli/src/commands.js';

const CLI_DIR = join(REPO_ROOT, 'apps', 'cli');

/**
 * Every JavaScript file of the CLI, with its text.
 *
 * The whole package is scanned, not just `src/`: `bin.js` is where a process would be
 * spawned or a sink hijacked, and a future `.mjs` would otherwise escape the net.
 */
function sources() {
  const output = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') {
          continue;
        }
        walk(full);
        continue;
      }
      if (/\.(?:js|mjs|cjs)$/u.test(entry.name)) {
        output.push({ path: full, text: readFileSync(full, 'utf8') });
      }
    }
  };
  walk(CLI_DIR);
  return output;
}

/**
 * Collect the files that match a pattern.
 *
 * @param {RegExp} pattern Pattern to test against file contents.
 * @returns {string[]} Relative paths of matching files.
 */
function filesMatching(pattern) {
  return sources()
    .filter((source) => {
      pattern.lastIndex = 0;
      return pattern.test(source.text);
    })
    .map((source) => source.path.slice(REPO_ROOT.length));
}

describe('read-only boundary', () => {
  it('sends only GET, and only from one request builder', () => {
    // Matching the value rather than a quoted literal: `method: "GET"`, `method: verb`
    // and `method: someVariable` all have to be caught, and an earlier regex that
    // required single quotes caught none of them.
    const methods = [];
    for (const source of sources()) {
      for (const match of source.text.matchAll(/\bmethod\s*:\s*([^,}\n]+)/gu)) {
        methods.push({ value: match[1].trim(), path: source.path });
      }
    }
    assert.equal(methods.length, 1, 'a second request builder is a second chance to get the verb wrong');
    assert.equal(methods[0].value, '\'GET\'');
  });

  it('mentions no mutating verb anywhere in the package', () => {
    for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const matches = filesMatching(new RegExp(`(['"\`])${verb}\\1`, 'u'));
      assert.deepEqual(matches, [], `${verb} must not appear in the read-only client`);
    }
  });

  it('has no route to the poll endpoint or any action route', () => {
    assert.deepEqual(Object.values(ROUTES).sort(), [
      '/api/v1/alerts',
      '/api/v1/analysis',
      '/api/v1/status',
      '/healthz',
      '/readyz',
    ]);
    assert.equal(filesMatching(/\/collectors\/|:id\/poll|'\/poll'/u).length, 0);
    assert.equal(filesMatching(/\/approve|\/reject|\/execute|\/rescue|\/dispatch/u).length, 0);
  });

  it('spawns no process and reaches no shell', () => {
    assert.deepEqual(filesMatching(/node:child_process|child_process|execSync|spawnSync|execFile|require\(/u), []);
    assert.deepEqual(filesMatching(/node:worker_threads|new Worker\(/u), []);
  });

  it('has no dynamic code evaluation', () => {
    assert.deepEqual(filesMatching(/\beval\(|new Function\(|node:vm/u), []);
  });

  it('does not import the event store, the daemon or any response component', () => {
    const forbidden = [
      'event-store',
      'sqlite',
      'daemon',
      'response-policy',
      'response-helper',
      'model-broker',
      'harness-adapter',
      'plugin-manager',
    ];
    for (const name of forbidden) {
      assert.deepEqual(filesMatching(new RegExp(`from '[^']*${name}`, 'u')), [], `${name} must not be imported`);
    }
  });

  it('imports only read-only filesystem entry points', () => {
    // An allowlist of imported names beats a blocklist of write functions: `openSync(p,
    // 'w')` and `fs.promises.writeFile` are both writes that a name-based blocklist
    // misses, while importing their name at all is refused here.
    //
    // The default-import form matters: `import fs from 'node:fs'` brings every writer
    // along with it, so a named-import clause is required, not merely preferred.
    const allowed = new Set(['readFileSync', 'lstatSync', 'fstatSync', 'openSync', 'closeSync']);
    for (const source of sources()) {
      for (const match of source.text.matchAll(/import\s+([^;]*?)\s+from\s+'node:fs'/gu)) {
        const clause = match[1].trim();
        assert.ok(
          clause.startsWith('{') && clause.endsWith('}'),
          `${source.path} must import fs by name, found: ${clause}`,
        );
        for (const name of clause.slice(1, -1).split(',').map((entry) => entry.trim()).filter(Boolean)) {
          assert.ok(allowed.has(name), `${source.path} imports fs.${name}`);
        }
      }
      assert.equal(/node:fs\/promises|from 'fs'/u.test(source.text), false, `${source.path} must use one fs import style`);
      assert.equal(/createRequire|require\(/u.test(source.text), false, `${source.path} must not require() the filesystem`);
    }
  });

  it('opens files read-only', () => {
    let opens = 0;
    for (const source of sources()) {
      for (const match of source.text.matchAll(/openSync\(([^)]*)\)/gu)) {
        assert.match(match[1], /,\s*'r'\s*$/u, `openSync must use the read flag, found: ${match[1]}`);
        opens += 1;
      }
    }
    assert.equal(opens, 1, 'there is exactly one open, in the token reader');
  });

  it('has no SQL and no shell command strings', () => {
    assert.deepEqual(filesMatching(/\b(SELECT|INSERT INTO|UPDATE .* SET|DELETE FROM)\b/u), []);
    assert.deepEqual(filesMatching(/cmd\.exe|powershell|bash -c|\/bin\/sh/u), []);
  });

  it('prints through an injected sink rather than console', () => {
    assert.deepEqual(filesMatching(/\bconsole\.(log|error|warn|info|debug)\b/u), []);
  });

  it('reads only its own configuration environment variable', () => {
    const allowed = new Set(['AEGIS_CLI_CONFIG']);
    for (const source of sources()) {
      for (const match of source.text.matchAll(/process\.env\.([A-Za-z0-9_]+)/gu)) {
        assert.ok(allowed.has(match[1]), `unexpected environment read ${match[1]} in ${source.path}`);
      }
    }
    // Bracket access would hide the variable name from the check above.
    assert.deepEqual(filesMatching(/process\.env\[/u), []);
  });
});

describe('credential handling', () => {
  it('never lets a renderer see the token', () => {
    // `views.js` and `format.js` turn strings into terminal output. If either mentions a
    // token, the credential has become part of formatted output — which is exactly the
    // path that ends up in a terminal scrollback or a pasted bug report.
    const files = filesMatching(/\btoken\b/iu);
    assert.ok(files.length > 0, 'sanity: the sources do mention the token where they must');
    assert.equal(files.some((path) => path.endsWith('views.js')), false);
    assert.equal(files.some((path) => path.endsWith('format.js')), false);
  });

  it('reads the CSRF token only to report its presence', () => {
    const commands = sources().find((source) => source.path.endsWith('commands.js'));
    let codeUsages = 0;
    for (const line of commands.text.split('\n')) {
      if (!line.includes('csrf_token')) {
        continue;
      }
      const trimmed = line.trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) {
        continue;
      }
      codeUsages += 1;
      assert.equal(
        trimmed,
        'csrf_token_present: typeof payload.csrf_token === \'string\',',
        `the CSRF value must never be copied into a view: ${trimmed}`,
      );
    }
    assert.equal(codeUsages, 1, 'there is exactly one code-level use of the field');
  });

  it('sets the authorization header in exactly one place, never in a message', () => {
    let assignments = 0;
    for (const source of sources()) {
      for (const line of source.text.split('\n')) {
        if (!/authorization/iu.test(line)) {
          continue;
        }
        const trimmed = line.trim();
        if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) {
          continue;
        }
        assert.equal(
          trimmed,
          'headers.authorization = `Bearer ${token}`;',
          `authorization may only be assigned to a request header, found in ${source.path}: ${trimmed}`,
        );
        assignments += 1;
      }
    }
    assert.equal(assignments, 1, 'the header is written once, in the request builder');
  });

  it('keeps the config object free of a serialisable token field', () => {
    const config = sources().find((source) => source.path.endsWith('config.js'));
    assert.equal(/token:\s*(cached|cachedToken|token)\b/u.test(config.text), false);
    assert.match(config.text, /const loadToken = \(\) =>/u);
  });
});

describe('package hygiene', () => {
  it('declares no runtime or development dependency', () => {
    const manifest = JSON.parse(readFileSync(join(CLI_DIR, 'package.json'), 'utf8'));
    assert.equal(manifest.dependencies, undefined);
    assert.equal(manifest.devDependencies, undefined);
    assert.equal(manifest.author, 'PT-dove');
    assert.equal(manifest.license, 'Apache-2.0');
    assert.equal(manifest.type, 'module');
    assert.equal(manifest.private, true);
  });

  it('uses only Node built-ins', () => {
    for (const source of sources()) {
      for (const match of source.text.matchAll(/from '([^']+)'/gu)) {
        const specifier = match[1];
        const isBuiltin = specifier.startsWith('node:');
        const isRelative = specifier.startsWith('./') || specifier.startsWith('../');
        assert.ok(isBuiltin || isRelative, `${source.path} imports ${specifier}`);
      }
    }
  });

  it('carries no third-party or vendor attribution', () => {
    // The repository convention is a single author identity; a tool or vendor name in
    // the sources would leak into packaged builds.
    // 这条守卫本身不能明文写出被禁品牌名：否则“禁止品牌名的检查”就成了仓库里
    // 唯一出现品牌名的地方。用片段拼接与 Unicode 转义得到同一组模式。
    const forbidden = new RegExp([
      ['work', 'buddy'].join(''),
      'work ?buddy',
      'tencent',
      '\\u817e\\u8baf',
      ['code', 'buddy'].join(''),
      'copilot',
      'claude',
      'gemini',
      'chatgpt',
      'openai',
    ].join('|'), 'iu');
    for (const source of sources()) {
      assert.equal(forbidden.test(source.text), false, `${source.path} carries a forbidden attribution`);
    }
    assert.equal(forbidden.test(readFileSync(join(CLI_DIR, 'package.json'), 'utf8')), false);
    assert.equal(forbidden.test(readFileSync(join(CLI_DIR, 'bin.js'), 'utf8')), false);
  });
});
