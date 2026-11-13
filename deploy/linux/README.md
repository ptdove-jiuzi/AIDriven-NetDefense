# deploy/linux — Debian packaging inputs

Author: PT-dove

These are the **inputs**, not the build product. `scripts/release/assemble-deb.sh`
copies them into a `dpkg` tree, substitutes the version, and builds
`aidriven-netdefense_<ver>_amd64.deb` plus `AIDrivenNetDefense-<ver>-linux-x64.tar.gz`.
Nothing here is executed at build time except the two `gzip` calls.

| File | Installed as | Mode |
|---|---|---|
| `control.in` | `DEBIAN/control` (`@VERSION@`, `@INSTALLED_SIZE@` substituted) | 0644 |
| `conffiles.in` | `DEBIAN/conffiles` | 0644 |
| `postinst` | `DEBIAN/postinst` | 0755 |
| `prerm` | `DEBIAN/prerm` | 0755 |
| `postrm` | `DEBIAN/postrm` | 0755 |
| `aegis.conf.json` | `/etc/aidriven-netdefense/aegis.conf.json` (conffile) | 0644, postinst tightens to 0640 root:aegis |
| `aidriven-netdefense-daemon.service` | `/usr/lib/systemd/system/` | 0644 |
| `aegis-cli.sh` | `/opt/aidriven-netdefense/bin/aegis-cli` (+ symlink `/usr/bin/aegis-cli`) | 0755 |
| `aegis-cli.1` | `/usr/share/man/man1/aegis-cli.1.gz` | 0644 |
| `copyright` | `/usr/share/doc/aidriven-netdefense/copyright` | 0644 |
| `changelog.Debian.in` | `/usr/share/doc/aidriven-netdefense/changelog.Debian.gz` | 0644 |

Layout and rationale: `docs/implementation/adr/ADR-0009-release-distribution.md` §5.3,
§5.4 and `docs/implementation/release/linux-install.md`.

## Decisions worth knowing before editing

- **The payload is inside the `.deb` (option L-B).** `linux-install.md` §6 recommends
  L-A (a small engine package that pulls the payload through our own A/B swap engine).
  This release is specified as a single self-contained `.deb`, so L-B is what is built.
  Consequence: upgrades are dpkg's file replacement, not the Windows state machine's
  staged swap. Recorded as a known deviation in `status/RELEASE-MATRIX.md`.
- **`/var/lib/aidriven-netdefense` is not in the package.** `postinst` creates it. A
  package that owns a data directory makes every later upgrade an ownership question,
  and an empty shipped tree can hide a failed seed.
- **`Maintainer` is `PT-dove <pt-dove@users.noreply.github.com>`.** The release contract
  says `Maintainer=PT-dove`; a bare name is not an RFC 2822 address and `lintian` reports
  it as an error, which the release gate forbids. The display name is exactly `PT-dove`.
- **`Type=simple`, not `notify`.** The daemon does not call `sd_notify`. See the comment
  block at the top of the unit file for the second (readiness probe) deviation.
- **`dir-or-file-in-opt` is suppressed.** ADR-0009 §5.3 mandates `/opt`. The gate runs
  `lintian` twice: once unsuppressed to prove that tag is the *only* error, then again
  with the suppression and `--fail-on error`.

## Building (on Ubuntu; not reproducible on Windows)

```sh
npm ci --omit=dev --no-audit --no-fund
node scripts/release/build-linux-payload.mjs --out "$RUNNER_TEMP/payload-linux" \
  --version 0.0.1-rc.2 --node-version v24.20.0 --cache "$RUNNER_TEMP/node-cache" --force
scripts/release/assemble-deb.sh --payload "$RUNNER_TEMP/payload-linux" \
  --version 0.0.1-rc.2 --out "$RUNNER_TEMP/out"
```

The Windows build host cannot produce a valid Linux payload: the Node runtime is a
linux-x64 binary and the native prebuilds in `node_modules` are installed per platform.
`build-linux-payload.mjs` refuses to run off Linux for exactly that reason.
