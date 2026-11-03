# Contributing

## Toolchain

Use Node.js 24.9.0 (minimum 24.9.0) and npm 11.6.0. The repository is ESM-only
and uses exact dependency versions with `package-lock.json`.

```sh
npm ci
npm test
npm run sbom:check
npm run license:check
```

After an intentional lockfile change, regenerate and review the SBOM:

```sh
npm run sbom:generate
```

`sbom.cdx.json` is generated from the actual lockfile. Do not hand-edit it.

## Test safety

Use `packages/test-support` to create a temporary sandbox. Configure its
`mock-real-root` explicitly as the protected snapshot root, compare snapshots
before and after the test, and treat every difference as a failure. Test
workloads may write only to the sandbox work directory. Fixtures must be
harmless synthetic data; real user directories and security logs are never
test inputs.

## Authorship and notices

Project authorship and attribution are PT-dove. Keep Apache-2.0, upstream MIT,
and all applicable third-party notices. Do not claim acceptance, OS coverage,
or WP0 GO without corresponding executable evidence.
