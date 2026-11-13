#!/usr/bin/env bash
# AIDriven NetDefense — assemble the linux-x64 .deb and the offline .tar.gz from a
# payload tree produced by scripts/release/build-linux-payload.mjs.
#
# Author: PT-dove
#
# Layout (ADR-0009 §5.3, FHS):
#   /opt/aidriven-netdefense/app/                payload, root:root 0755
#   /opt/aidriven-netdefense/bin/aegis-cli       client stub
#   /usr/bin/aegis-cli -> /opt/…/bin/aegis-cli
#   /usr/lib/systemd/system/aidriven-netdefense-daemon.service
#   /etc/aidriven-netdefense/aegis.conf.json     conffile
#   /usr/share/doc/aidriven-netdefense/{copyright,changelog.Debian.gz}
#   /usr/share/man/man1/aegis-cli.1.gz
#
# /var/lib/aidriven-netdefense is deliberately NOT in the package: postinst creates it.
# A package that owns a data directory turns every later upgrade into an ownership
# question, and dpkg would happily ship an empty tree that hides a failed seed.
#
# The .deb contains the payload directly (option L-B in docs/implementation/release/
# linux-install.md §6). That document recommends L-A — a small engine package that
# pulls the payload through our own A/B swap engine — but this release is specified as
# a single self-contained .deb, so L-B is what is built here. The consequence is
# recorded as a known deviation in status/RELEASE-MATRIX.md: upgrades are dpkg's, not
# the Windows state machine's.
#
# usage:
#   scripts/release/assemble-deb.sh --payload <dir> --version <ver> --out <dir>
#     [--assets <deploy/linux>] [--compression xz|gzip|none]
#
# Outputs, in --out:
#   aidriven-netdefense_<ver>_amd64.deb
#   AIDrivenNetDefense-<ver>-linux-x64.tar.gz

set -euo pipefail

PKG=aidriven-netdefense
SVC=aidriven-netdefense-daemon
PRODUCT=AIDrivenNetDefense
OPT=/opt/$PKG
ETC=/etc/$PKG
VAR=/var/lib/$PKG

PAYLOAD=""
VERSION=""
OUT=""
ASSETS="$(cd "$(dirname "$0")/../../deploy/linux" && pwd)"
COMPRESSION="xz"

die() { printf 'assemble-deb: %s\n' "$*" >&2; exit 1; }
say() { printf 'assemble-deb: %s\n' "$*" >&2; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --payload) PAYLOAD="${2:-}"; shift 2 ;;
    --version) VERSION="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    --assets) ASSETS="${2:-}"; shift 2 ;;
    --compression) COMPRESSION="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) die "unknown argument $1" ;;
  esac
done

[ -n "$PAYLOAD" ] || die "--payload is required"
[ -n "$VERSION" ] || die "--version is required"
[ -n "$OUT" ] || die "--out is required"
case "$VERSION" in
  [0-9]*.[0-9]*.[0-9]*) : ;;
  *) die "not a semantic version: $VERSION" ;;
esac
[ -d "$PAYLOAD" ] || die "payload directory does not exist: $PAYLOAD"
[ -f "$PAYLOAD/bundle.json" ] || die "payload has no bundle.json: $PAYLOAD"
[ -f "$PAYLOAD/manifests/files.sha256" ] || die "payload has no manifests/files.sha256: $PAYLOAD"
[ -x "$PAYLOAD/runtime/node/bin/node" ] || die "payload has no executable runtime/node/bin/node: $PAYLOAD"
[ -d "$ASSETS" ] || die "asset directory does not exist: $ASSETS"
for required in control.in postinst prerm postrm conffiles.in copyright changelog.Debian.in \
                aegis-cli.sh aegis-cli.1 aegis.conf.json aidriven-netdefense-daemon.service; do
  [ -f "$ASSETS/$required" ] || die "missing packaging file: $ASSETS/$required"
done

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/aidn-deb-XXXXXX")"
trap 'rm -rf "$work"' EXIT
tree="$work/deb"
stage="$work/tar"

say "payload: $PAYLOAD"
say "version: $VERSION"
say "work:    $work"

# ---------------------------------------------------------------- package tree ---
mkdir -p \
  "$tree$OPT/app" "$tree$OPT/bin" \
  "$tree$ETC" \
  "$tree/usr/bin" "$tree/usr/lib/systemd/system" \
  "$tree/usr/share/doc/$PKG" "$tree/usr/share/man/man1" \
  "$tree/DEBIAN"

say "copying payload into $OPT/app"
cp -a "$PAYLOAD/." "$tree$OPT/app/"

install -m 0755 "$ASSETS/aegis-cli.sh" "$tree$OPT/bin/aegis-cli"
ln -sfn "$OPT/bin/aegis-cli" "$tree/usr/bin/aegis-cli"
install -m 0644 "$ASSETS/aidriven-netdefense-daemon.service" "$tree/usr/lib/systemd/system/$SVC.service"
install -m 0644 "$ASSETS/aegis.conf.json" "$tree$ETC/aegis.conf.json"
install -m 0644 "$ASSETS/copyright" "$tree/usr/share/doc/$PKG/copyright"

gzip -9n -c "$ASSETS/aegis-cli.1" >"$tree/usr/share/man/man1/aegis-cli.1.gz"
chmod 0644 "$tree/usr/share/man/man1/aegis-cli.1.gz"

debian_date="$(LC_ALL=C date -u '+%a, %d %b %Y %H:%M:%S +0000')"
sed -e "s|@VERSION@|$VERSION|g" -e "s|@DATE@|$debian_date|g" \
  "$ASSETS/changelog.Debian.in" | gzip -9n >"$tree/usr/share/doc/$PKG/changelog.Debian.gz"
chmod 0644 "$tree/usr/share/doc/$PKG/changelog.Debian.gz"

# ------------------------------------------------------------------- metadata ---
installed_size="$(du -sk --exclude=DEBIAN "$tree" | cut -f1)"
sed -e "s|@VERSION@|$VERSION|g" -e "s|@INSTALLED_SIZE@|$installed_size|g" \
  "$ASSETS/control.in" >"$tree/DEBIAN/control"
chmod 0644 "$tree/DEBIAN/control"

sed -e "s|@VERSION@|$VERSION|g" "$ASSETS/conffiles.in" >"$tree/DEBIAN/conffiles"
chmod 0644 "$tree/DEBIAN/conffiles"

install -m 0755 "$ASSETS/postinst" "$tree/DEBIAN/postinst"
install -m 0755 "$ASSETS/prerm" "$tree/DEBIAN/prerm"
install -m 0755 "$ASSETS/postrm" "$tree/DEBIAN/postrm"

# dpkg-deb does not generate md5sums (that is dh_md5sums' job). Shipping them keeps
# `dpkg -V` meaningful and silences the one avoidable lintian warning about it.
(
  cd "$tree"
  find . -type f ! -path './DEBIAN/*' -printf '%P\n' | LC_ALL=C sort | xargs -r md5sum >"DEBIAN/md5sums"
)
chmod 0644 "$tree/DEBIAN/md5sums"

# Nothing in the package may be group- or world-writable; dpkg would preserve it.
find "$tree" -type d -exec chmod 0755 {} +
find "$tree" -type f -perm -0002 -exec chmod o-w {} +
find "$tree" -type f -perm -0020 -exec chmod g-w {} +

deb="$OUT/${PKG}_${VERSION}_amd64.deb"
say "building $deb ($installed_size KiB installed)"
dpkg-deb --root-owner-group -Z"$COMPRESSION" --build "$tree" "$deb"

# --------------------------------------------------------------- offline tar.gz ---
say "building offline archive"
mkdir -p "$stage$OPT" "$stage$ETC" "$stage/usr/bin" "$stage/usr/lib/systemd/system" \
         "$stage/usr/share/doc/$PKG" "$stage/usr/share/man/man1"
cp -a "$tree$OPT/." "$stage$OPT/"
cp -a "$tree$ETC/." "$stage$ETC/"
cp -a "$tree/usr/lib/systemd/system/$SVC.service" "$stage/usr/lib/systemd/system/"
cp -a "$tree/usr/share/doc/$PKG/." "$stage/usr/share/doc/$PKG/"
cp -a "$tree/usr/share/man/man1/aegis-cli.1.gz" "$stage/usr/share/man/man1/"
ln -sfn "$OPT/bin/aegis-cli" "$stage/usr/bin/aegis-cli"

cat >"$stage/INSTALL.txt" <<EOF
AIDriven NetDefense $VERSION — linux-x64 offline archive
Author: PT-dove

This archive is the same tree the .deb installs, with no packaging metadata: nothing
here registers a service, creates a user, or tracks files for removal. Extracting it as
root over / gives you the files; the steps below give you a working install.

  sudo tar -xzf ${PRODUCT}-${VERSION}-linux-x64.tar.gz -C /

1. Create the service account (no home, no shell):

   sudo addgroup --system aegis
   sudo adduser --system --home $VAR --no-create-home --ingroup aegis \\
     --shell /usr/sbin/nologin --gecos "AIDriven NetDefense" aegis
   sudo adduser aegis adm
   sudo adduser aegis systemd-journal

2. Create the writable state tree:

   sudo install -d -m 0750 -o aegis -g aegis $VAR \\
     $VAR/store $VAR/secrets $VAR/analysis $VAR/rules \\
     $VAR/install $VAR/install/backup $VAR/install/backup/db
   sudo install -d -m 0750 -o root -g aegis $ETC
   sudo chown root:aegis $ETC/aegis.conf.json
   sudo chmod 0640 $ETC/aegis.conf.json

3. Generate the API token (do not reuse one from another host):

   sudo sh -c 'openssl rand -hex 32 > $VAR/secrets/api-token'
   sudo chown aegis:aegis $VAR/secrets/api-token
   sudo chmod 0600 $VAR/secrets/api-token

4. Seed the rule pack the daemon refuses to start without:

   sudo install -m 0640 -o aegis -g aegis \\
     $OPT/app/rules/defense-seed-pack.json $VAR/rules/defense-seed-pack.json

5. Verify the payload against its own manifest (G4):

   cd $OPT/app && sudo sha256sum -c --quiet manifests/files.sha256

6. Enable and start:

   sudo systemctl daemon-reload
   sudo systemctl enable --now $SVC.service
   systemctl status $SVC.service

Known limits of this archive: no automatic upgrade, no removal tracking, and no
conffile handling — future releases will not merge your edits to aegis.conf.json.

Uninstall: stop and disable the unit, delete /usr/bin/aegis-cli, /usr/lib/systemd/
system/$SVC.service, $OPT, $ETC and (after backing up) $VAR.
EOF

tar_name="${PRODUCT}-${VERSION}-linux-x64.tar.gz"
tar --sort=name --owner=0 --group=0 --numeric-owner \
    --mtime="@${SOURCE_DATE_EPOCH:-0}" \
    -C "$stage" -cf - . | gzip -9n >"$OUT/$tar_name"

say "done"
for artefact in "$deb" "$OUT/$tar_name"; do
  bytes="$(stat -c %s "$artefact")"
  hash="$(sha256sum "$artefact" | cut -d' ' -f1)"
  printf '%s\n  bytes  %s\n  sha256 %s\n' "$artefact" "$bytes" "$hash" >&2
done

say "control fields:"
dpkg-deb -I "$deb" >&2
say "note: lintian is run by scripts/release/verify-assets.mjs, not here (one gate, one place)"
