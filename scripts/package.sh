#!/usr/bin/env sh
# Builds the packages people install Symposium from on Linux:
#
#   dist/packages/symposium-<version>-1.x86_64.rpm   Fedora, RHEL and relatives, openSUSE
#   dist/packages/symposium_<version>_amd64.deb      Debian, Ubuntu, and Ubuntu under WSL
#   dist/packages/install.sh                         picks the right one and installs it
#
#   scripts/package.sh            both packages
#   scripts/package.sh rpm        only the .rpm (needs rpmbuild)
#   scripts/package.sh deb        only the .deb (needs ar, tar and xz)
#
# Each package holds the built app and its own copy of Node.js, so the computer it is installed
# on needs neither Node.js nor pnpm. It still needs git and an agent program.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

# The Node.js that travels inside the packages. Raise it on purpose, then run
# scripts/test-packages.sh.
NODE_VERSION=${SYMPOSIUM_NODE_VERSION:-22.23.1}
# The oldest C library the bundled SQLite binary runs on. It sets which systems can install.
MIN_GLIBC=2.34

WANT=${1:-all}
case "$WANT" in
  all | rpm | deb) ;;
  -h | --help)
    sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  *)
    echo "Unknown option: $WANT. Use rpm, deb or nothing for both." >&2
    exit 2
    ;;
esac

say() { printf '\n==> %s\n' "$1"; }
fail() {
  printf '\nCould not build the packages: %s\n' "$1" >&2
  exit 1
}

[ "$(uname -s)" = Linux ] || fail "packages are built on Linux."
[ "$(uname -m)" = x86_64 ] || fail "only x86_64 (Intel and AMD) packages can be built so far."
for tool in node pnpm curl tar xz sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is needed."
done
if [ "$WANT" != deb ]; then
  command -v rpmbuild >/dev/null 2>&1 || fail "rpmbuild is needed for the .rpm. Install rpm-build, or run: scripts/package.sh deb"
fi
if [ "$WANT" != rpm ]; then
  command -v ar >/dev/null 2>&1 || fail "ar is needed for the .deb. Install binutils, or run: scripts/package.sh rpm"
fi

VERSION=$(node -p 'require("./package.json").version')
OUT=$ROOT/dist/packages
CACHE=$ROOT/dist/cache
STAGE=$ROOT/dist/pkgroot
SUMMARY="Run a software project with a team of AI agents"

say "Building Symposium $VERSION"
node scripts/build-app.mjs

say "Fetching Node.js $NODE_VERSION, which travels inside the packages"
TARBALL=node-v$NODE_VERSION-linux-x64.tar.xz
mkdir -p "$CACHE"
[ -f "$CACHE/$TARBALL" ] || curl -fsSL -o "$CACHE/$TARBALL" "https://nodejs.org/dist/v$NODE_VERSION/$TARBALL"
curl -fsSL -o "$CACHE/SHASUMS256-$NODE_VERSION.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
(cd "$CACHE" && grep " $TARBALL\$" "SHASUMS256-$NODE_VERSION.txt" | sha256sum -c -) ||
  fail "the Node.js download does not match its published checksum. Delete dist/cache and try again."

say "Laying out the files as they will be installed"
rm -rf "$STAGE" "$OUT"
mkdir -p "$STAGE/opt" "$STAGE/usr/bin" "$STAGE/usr/share/applications" \
  "$STAGE/usr/share/icons/hicolor/scalable/apps" "$OUT"
cp -a dist/app "$STAGE/opt/symposium"
mkdir -p "$STAGE/opt/symposium/runtime"
tar -xJf "$CACHE/$TARBALL" -C "$STAGE/opt/symposium/runtime" --strip-components=2 \
  "node-v$NODE_VERSION-linux-x64/bin/node"
tar -xJf "$CACHE/$TARBALL" -C "$STAGE/opt/symposium/runtime" --strip-components=1 \
  "node-v$NODE_VERSION-linux-x64/LICENSE"
mv "$STAGE/opt/symposium/runtime/LICENSE" "$STAGE/opt/symposium/runtime/LICENSE-nodejs"

cat >"$STAGE/usr/bin/symposium" <<'LAUNCH'
#!/bin/sh
# Starts Symposium with the Node.js that came in its package.
exec /opt/symposium/runtime/node /opt/symposium/bin/symposium.mjs "$@"
LAUNCH
chmod 755 "$STAGE/usr/bin/symposium"

cat >"$STAGE/usr/share/applications/symposium.desktop" <<ENTRY
[Desktop Entry]
Type=Application
Name=Symposium
Comment=$SUMMARY
Exec=symposium --app
Icon=symposium
Terminal=false
Categories=Development;
ENTRY
cp assets/symposium.svg "$STAGE/usr/share/icons/hicolor/scalable/apps/symposium.svg"
# Readable by everyone, writable by the owner, runnable where it already was.
chmod -R u=rwX,go=rX "$STAGE"

"$STAGE/opt/symposium/runtime/node" "$STAGE/opt/symposium/bin/symposium.mjs" --version >/dev/null ||
  fail "the staged app does not start with the bundled Node.js."

if [ "$WANT" != deb ]; then
  say "Building the .rpm"
  TOP=$ROOT/dist/rpmbuild
  rm -rf "$TOP"
  mkdir -p "$TOP/SPECS"
  cat >"$TOP/SPECS/symposium.spec" <<SPEC
Name:           symposium
Version:        $VERSION
Release:        1
Summary:        $SUMMARY
License:        MIT
BuildArch:      x86_64
# The files are ready-made. Nothing is to be stripped, scanned or rewritten.
AutoReqProv:    no
Requires:       git
Requires:       glibc >= $MIN_GLIBC
Requires:       libstdc++
%global debug_package %{nil}
%global __os_install_post %{nil}
%global _build_id_links none

%description
Symposium is a group chat where you hire AI agents as a team and run a
software project as its CEO. It runs on your own computer. This package
includes its own Node.js. You also need git and an agent program such as
Claude Code or Antigravity.

%install
mkdir -p %{buildroot}
cp -a "$STAGE/." %{buildroot}/

%files
%defattr(-,root,root,-)
/opt/symposium
/usr/bin/symposium
/usr/share/applications/symposium.desktop
/usr/share/icons/hicolor/scalable/apps/symposium.svg
SPEC
  rpmbuild -bb --quiet \
    --define "_topdir $TOP" \
    --define "_rpmdir $TOP/RPMS" \
    --define "_buildhost localhost" \
    "$TOP/SPECS/symposium.spec"
  mv "$TOP/RPMS/x86_64/symposium-$VERSION-1.x86_64.rpm" "$OUT/"
  rm -rf "$TOP"
fi

if [ "$WANT" != rpm ]; then
  say "Building the .deb"
  DEB=$ROOT/dist/deb
  rm -rf "$DEB"
  mkdir -p "$DEB/control"
  cat >"$DEB/control/control" <<CONTROL
Package: symposium
Version: $VERSION
Section: devel
Priority: optional
Architecture: amd64
Depends: git, libc6 (>= $MIN_GLIBC), libstdc++6 (>= 11)
Installed-Size: $(du -sk "$STAGE" | cut -f1)
Maintainer: Symposium project <noreply@symposium.invalid>
Description: $SUMMARY
 Symposium is a group chat where you hire AI agents as a team and run a
 software project as its CEO. It runs on your own computer. This package
 includes its own Node.js. You also need git and an agent program such as
 Claude Code or Antigravity.
CONTROL
  (cd "$STAGE" && find opt usr -type f -exec md5sum {} + | sort -k2) >"$DEB/control/md5sums"
  # A .deb is an ar archive of three files, in this order. Everything inside belongs to root.
  printf '2.0\n' >"$DEB/debian-binary"
  tar -C "$DEB/control" --owner=0 --group=0 --numeric-owner -cJf "$DEB/control.tar.xz" ./control ./md5sums
  tar -C "$STAGE" --owner=0 --group=0 --numeric-owner --sort=name -cJf "$DEB/data.tar.xz" ./opt ./usr
  (cd "$DEB" && ar rcD "$OUT/symposium_${VERSION}_amd64.deb" debian-binary control.tar.xz data.tar.xz)
  rm -rf "$DEB"
fi

cp scripts/install-package.sh "$OUT/install.sh"
chmod 755 "$OUT/install.sh"
(cd "$OUT" && sha256sum symposium* >SHA256SUMS)
rm -rf "$STAGE"

say "Done"
ls -lh "$OUT" | awk 'NR > 1 { printf "  %-40s %s\n", $NF, $5 }'
cat <<NEXT

Install on this computer, or on any other with the files:
  sh dist/packages/install.sh        picks the package that fits and installs it
Or by hand:
  sudo dnf install ./dist/packages/symposium-$VERSION-1.x86_64.rpm     Fedora, RHEL
  sudo apt install ./dist/packages/symposium_${VERSION}_amd64.deb       Debian, Ubuntu, WSL
Check the packages in clean containers first:  scripts/test-packages.sh
NEXT
