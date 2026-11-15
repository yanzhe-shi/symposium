#!/usr/bin/env sh
# Tries the packages from scripts/package.sh in clean containers, the way a new user would
# meet them: install with the system's package manager, start, use, stop, remove.
#
#   scripts/test-packages.sh            every system below
#   scripts/test-packages.sh fedora     only the ones whose name contains "fedora"
#
# Needs podman (or docker, with CONTAINER=docker) and a network connection.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PKG=$ROOT/dist/packages
ENGINE=${CONTAINER:-podman}
ONLY=${1:-}
[ -d "$PKG" ] || {
  echo "No packages in dist/packages. Run scripts/package.sh first." >&2
  exit 1
}

# name | image | how to get ready | how to remove
SYSTEMS='
fedora-latest|registry.fedoraproject.org/fedora:latest|true|dnf -y -q remove symposium
ubuntu-22.04|docker.io/library/ubuntu:22.04|apt-get -qq update|apt-get -qq -y remove symposium
debian-stable|docker.io/library/debian:stable-slim|apt-get -qq update|apt-get -qq -y remove symposium
'

# What runs inside each container. The installer script chooses the package. The check after
# removal looks at the files: `command -v` would answer from where the shell remembers it was.
INSIDE='
set -eu
export DEBIAN_FRONTEND=noninteractive
PREPARE
sh /pkg/install.sh --print
sh /pkg/install.sh --yes >/tmp/install.log 2>&1 || { cat /tmp/install.log; exit 1; }
echo "installed: $(symposium --version)"
test -f /usr/share/applications/symposium.desktop
export SYMPOSIUM_HOME=/tmp/symposium-home SYMPOSIUM_PROJECTS_DIR=/tmp/symposium-projects
symposium --no-open >/tmp/symposium.log 2>&1 &
/opt/symposium/runtime/node /scripts/smoke-test.mjs http://127.0.0.1:4400 /tmp/symposium-projects/smoke || { cat /tmp/symposium.log; exit 1; }
symposium status
symposium stop
REMOVE >/dev/null 2>&1
for left in /opt/symposium /usr/bin/symposium /usr/share/applications/symposium.desktop; do
  if [ -e "$left" ]; then echo "still there after removal: $left"; exit 1; fi
done
echo "removed cleanly"
'

FAILED=
echo "$SYSTEMS" | while IFS='|' read -r name image prepare remove; do
  [ -n "$name" ] || continue
  case "$name" in *"$ONLY"*) ;; *) continue ;; esac
  printf '\n==> %s\n' "$name"
  script=$(printf '%s' "$INSIDE" | sed "s#PREPARE#$prepare#; s#REMOVE#$remove#")
  if "$ENGINE" run --rm --security-opt label=disable \
    -v "$PKG:/pkg:ro" -v "$ROOT/scripts:/scripts:ro" "$image" sh -c "$script"; then
    echo "PASS $name"
  else
    echo "FAIL $name"
    # A pipeline runs in a subshell, so the result is handed over in a file.
    echo "$name" >>"$ROOT/dist/test-packages.failed"
  fi
done
if [ -f "$ROOT/dist/test-packages.failed" ]; then
  FAILED=$(tr '\n' ' ' <"$ROOT/dist/test-packages.failed")
  rm -f "$ROOT/dist/test-packages.failed"
  printf '\nFailed on: %s\n' "$FAILED"
  exit 1
fi
printf '\nEvery system passed.\n'
