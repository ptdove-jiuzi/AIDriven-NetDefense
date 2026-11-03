/**
 * config.test.js — the configuration boundary.
 *
 * Every assertion here corresponds to a way a misconfiguration could quietly
 * become a security problem: a wildcard bind, a data directory that escapes into
 * the user's profile, an unknown key that silently falls back to a default, or a
 * daemon that starts without detection rules and looks healthy while detecting
 * nothing.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

import {
  LOOPBACK_HOSTS,
  assertLoopbackHost,
  loadConfig,
  loadConfigFile,
  resolveInside,
} from '../../apps/daemon/src/config.js';
import { DAEMON_CODES } from '../../apps/daemon/src/errors.js';
import { makeConfig, makeRulePack, makeTempDir } from './helpers.js';

const PACK = makeRulePack();

describe('loadConfig', () => {
  it('requires an explicit absolute data directory', () => {
    assert.throws(() => loadConfig({ detection: { rulePack: PACK } }), (error) => {
      assert.equal(error.code, DAEMON_CODES.CONFIG_INVALID);
      assert.match(error.message, /dataDir is required/u);
      return true;
    });
    assert.throws(() => loadConfig({ dataDir: 'relative/path', detection: { rulePack: PACK } }), (error) => {
      assert.equal(error.code, DAEMON_CODES.CONFIG_INVALID);
      assert.match(error.message, /absolute/u);
      return true;
    });
  });

  it('derives store, checkpoint and token paths inside the data directory', () => {
    const dir = makeTempDir();
    const config = makeConfig(dir);
    assert.equal(config.dataDir, dir);
    assert.ok(config.store.path.startsWith(dir));
    assert.ok(config.state.path.startsWith(dir));
    assert.ok(config.api.tokenFile.startsWith(dir));
    assert.equal(config.store.path, join(dir, 'store', 'aegis.db'));
  });

  it('defaults to the loopback literal address and an ephemeral port', () => {
    const config = makeConfig(makeTempDir());
    assert.equal(config.api.host, '127.0.0.1');
    assert.equal(config.api.port, 0);
    assert.deepEqual([...LOOPBACK_HOSTS], ['127.0.0.1', '::1']);
  });

  it('accepts ::1 as a loopback bind address', () => {
    const config = makeConfig(makeTempDir(), { api: { host: '::1' } });
    assert.equal(config.api.host, '::1');
  });

  for (const host of ['0.0.0.0', '::', 'localhost', '127.0.0.2', '10.0.0.1', 'example.com']) {
    it(`refuses to bind ${host}`, () => {
      assert.throws(() => makeConfig(makeTempDir(), { api: { host } }), (error) => {
        assert.equal(error.code, DAEMON_CODES.CONFIG_NOT_LOOPBACK);
        return true;
      });
    });
  }

  it('rejects unknown top-level keys', () => {
    assert.throws(
      () => loadConfig({ dataDir: makeTempDir(), detection: { rulePack: PACK }, apiPort: 8080 }),
      (error) => {
        assert.equal(error.code, DAEMON_CODES.CONFIG_INVALID);
        assert.match(error.message, /unknown key "apiPort"/u);
        return true;
      },
    );
  });

  it('rejects unknown keys inside a section', () => {
    assert.throws(
      () => loadConfig({ dataDir: makeTempDir(), detection: { rulePack: PACK }, api: { maxBody: 10 } }),
      (error) => {
        assert.match(error.message, /api has unknown key "maxBody"/u);
        return true;
      },
    );
  });

  it('rejects a path that escapes the data directory', () => {
    const dir = makeTempDir();
    assert.throws(() => makeConfig(dir, { top: { store: { path: join(dir, '..', 'escaped.db') } } }), (error) => {
      assert.equal(error.code, DAEMON_CODES.CONFIG_PATH_ESCAPE);
      return true;
    });
  });

  it('rejects an absolute store path outside the data directory', () => {
    const dir = makeTempDir();
    assert.throws(
      () => loadConfig({ dataDir: dir, detection: { rulePack: PACK }, store: { path: 'C:/Windows/evil.db' } }),
      (error) => {
        assert.equal(error.code, DAEMON_CODES.CONFIG_PATH_ESCAPE);
        return true;
      },
    );
  });

  it('requires a rule pack in both modes', () => {
    for (const mode of ['full', 'mock']) {
      assert.throws(() => loadConfig({ dataDir: makeTempDir(), mode }), (error) => {
        assert.equal(error.code, DAEMON_CODES.CONFIG_INVALID);
        assert.match(error.message, /rule pack/u);
        return true;
      });
    }
  });

  it('refuses to declare both an inline pack and a pack path', () => {
    assert.throws(
      () => loadConfig({
        dataDir: makeTempDir(),
        mode: 'mock',
        detection: { rulePack: PACK, rulePackPath: 'rules.json' },
      }),
      (error) => {
        assert.match(error.message, /not both/u);
        return true;
      },
    );
  });

  it('rejects an inline rule pack that is not an object', () => {
    assert.throws(
      () => loadConfig({ dataDir: makeTempDir(), mode: 'mock', detection: { rulePack: [] } }),
      (error) => {
        assert.match(error.message, /must be an object/u);
        return true;
      },
    );
  });

  it('rejects an unknown mode', () => {
    assert.throws(
      () => loadConfig({ dataDir: makeTempDir(), mode: 'production', detection: { rulePack: PACK } }),
      (error) => {
        assert.match(error.message, /mode must be one of/u);
        return true;
      },
    );
  });

  it('bounds the port and the body limit', () => {
    assert.throws(() => makeConfig(makeTempDir(), { api: { port: 70000 } }), /port must be an integer/u);
    assert.throws(() => makeConfig(makeTempDir(), { api: { port: -1 } }), /port must be an integer/u);
    assert.throws(() => makeConfig(makeTempDir(), { api: { port: 1.5 } }), /port must be an integer/u);
    assert.throws(() => makeConfig(makeTempDir(), { api: { maxBodyBytes: 2_000_000 } }), /maxBodyBytes/u);
    assert.throws(() => makeConfig(makeTempDir(), { top: { scheduler: { tickMs: 0 } } }), /tickMs/u);
  });

  it('rejects a short inline token', () => {
    assert.throws(() => makeConfig(makeTempDir(), { api: { token: 'short' } }), (error) => {
      assert.match(error.message, /base64url/u);
      return true;
    });
  });

  it('rejects an unknown alert status and a malformed epoch', () => {
    assert.throws(
      () => loadConfig({ dataDir: makeTempDir(), detection: { rulePack: PACK }, policy: { alertStatus: 'open' } }),
      /alertStatus/u,
    );
    assert.throws(
      () => loadConfig({ dataDir: makeTempDir(), detection: { rulePack: PACK }, policy: { epoch: 7 } }),
      /epoch/u,
    );
  });

  it('rejects a non-array summary allowlist and an unknown log level', () => {
    assert.throws(
      () => loadConfig({
        dataDir: makeTempDir(),
        detection: { rulePack: PACK },
        policy: { allowedSummaryFields: 'alert_count' },
      }),
      /allowedSummaryFields/u,
    );
    assert.throws(
      () => loadConfig({ dataDir: makeTempDir(), detection: { rulePack: PACK }, logging: { level: 'trace' } }),
      /logging.level/u,
    );
  });

  it('returns a frozen configuration', () => {
    const config = makeConfig(makeTempDir());
    assert.ok(Object.isFrozen(config));
    assert.ok(Object.isFrozen(config.api));
    assert.ok(Object.isFrozen(config.scheduler));
    assert.throws(() => {
      config.api.port = 9999;
    }, TypeError);
  });

  it('defaults the summary allowlist and the budget class', () => {
    const config = makeConfig(makeTempDir());
    assert.deepEqual([...config.policy.allowedSummaryFields].sort(), [
      'alert_count',
      'rule_type',
      'sequence_in_hour',
      'severity_rank',
    ]);
    assert.equal(config.policy.budgetClass, 'standard');
    assert.equal(config.policy.alertStatus, 'new');
  });
});

describe('resolveInside', () => {
  it('resolves a relative path under the data directory', () => {
    const dir = makeTempDir();
    assert.equal(resolveInside(dir, 'a/b.json', 'x'), join(dir, 'a', 'b.json'));
  });

  it('refuses the data directory itself and traversal', () => {
    const dir = makeTempDir();
    assert.throws(() => resolveInside(dir, '.', 'x'), /not the directory itself/u);
    assert.throws(() => resolveInside(dir, '../outside.json', 'x'), (error) => {
      assert.equal(error.code, DAEMON_CODES.CONFIG_PATH_ESCAPE);
      return true;
    });
  });
});

describe('assertLoopbackHost', () => {
  it('accepts the two literal loopback addresses only', () => {
    assert.equal(assertLoopbackHost('127.0.0.1'), '127.0.0.1');
    assert.equal(assertLoopbackHost('::1'), '::1');
    assert.throws(() => assertLoopbackHost('127.0.0.1:80'), (error) => {
      assert.equal(error.code, DAEMON_CODES.CONFIG_NOT_LOOPBACK);
      return true;
    });
  });
});

describe('loadConfigFile', () => {
  it('reads and validates a JSON file', () => {
    const dir = makeTempDir();
    const file = join(dir, 'daemon.json');
    writeFileSync(file, JSON.stringify({
      dataDir: dir,
      mode: 'mock',
      detection: { rulePack: PACK },
      logging: { level: 'error' },
    }), 'utf8');
    const config = loadConfigFile(file);
    assert.equal(config.mode, 'mock');
    assert.equal(config.logging.level, 'error');
  });

  it('reports a missing file and invalid JSON distinctly', () => {
    const dir = makeTempDir();
    assert.throws(() => loadConfigFile(join(dir, 'absent.json')), (error) => {
      assert.equal(error.code, DAEMON_CODES.CONFIG_NOT_FOUND);
      return true;
    });
    const broken = join(dir, 'broken.json');
    writeFileSync(broken, '{ not json', 'utf8');
    assert.throws(() => loadConfigFile(broken), (error) => {
      assert.equal(error.code, DAEMON_CODES.CONFIG_INVALID);
      assert.match(error.message, /not valid JSON/u);
      return true;
    });
  });
});
