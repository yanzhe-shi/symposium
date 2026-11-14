#!/usr/bin/env sh
# Installs Symposium for you on Linux, macOS or WSL: fetches its packages, builds the chat page
# and adds a `symposium` command (and, on Linux, an entry in your applications menu).
#
#   scripts/install.sh              install for your user, no sudo
#   scripts/install.sh --system     put the command in /usr/local/bin (asks for sudo)
#   scripts/install.sh --uninstall  remove the command and the menu entry
#
# Your data (~/.symposium) and your projects are never touched by this script.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SYSTEM=no
UNINSTALL=no
for arg in "$@"; do
  case "$arg" in
    --system) SYSTEM=yes ;;
    --uninstall) UNINSTALL=yes ;;
    -h | --help)
      sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

if [ "$SYSTEM" = yes ]; then
  BIN_DIR=/usr/local/bin
  APPS_DIR=/usr/share/applications
  SUDO=sudo
else
  BIN_DIR=${SYMPOSIUM_BIN_DIR:-$HOME/.local/bin}
  APPS_DIR=${XDG_DATA_HOME:-$HOME/.local/share}/applications
  SUDO=
fi
LAUNCHER=$BIN_DIR/symposium
DESKTOP=$APPS_DIR/symposium.desktop

if [ "$UNINSTALL" = yes ]; then
  $SUDO rm -f "$LAUNCHER" "$DESKTOP"
  echo "Removed $LAUNCHER and the menu entry."
  echo "Your data in ~/.symposium and your projects are still there."
  exit 0
fi

say() { printf '\n==> %s\n' "$1"; }
fail() {
  printf '\nCould not install: %s\n' "$1" >&2
  exit 1
}

say "Checking what Symposium needs"
command -v node >/dev/null 2>&1 || fail "Node.js is not installed. Get version 22 or newer from https://nodejs.org, then run this again."
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 22 ] || fail "Node.js $(node --version) is too old. Symposium needs version 22 or newer."
command -v git >/dev/null 2>&1 || fail "git is not installed. Install it with your package manager, then run this again."
echo "Node.js $(node --version) and $(git --version) found."

# pnpm itself, or the copy Node.js can fetch on its own.
if command -v pnpm >/dev/null 2>&1; then
  PNPM=pnpm
elif command -v corepack >/dev/null 2>&1; then
  PNPM="corepack pnpm"
else
  PNPM="npx --yes pnpm@12"
fi

say "Fetching packages (this can take a minute)"
(cd "$ROOT" && $PNPM install --frozen-lockfile)

say "Building the chat page"
(cd "$ROOT" && $PNPM build)

say "Adding the symposium command"
TMP=$(mktemp)
cat >"$TMP" <<LAUNCH
#!/usr/bin/env sh
# Made by Symposium's scripts/install.sh.
exec node "$ROOT/bin/symposium.mjs" "\$@"
LAUNCH
$SUDO mkdir -p "$BIN_DIR"
$SUDO install -m 755 "$TMP" "$LAUNCHER"
rm -f "$TMP"
echo "$LAUNCHER"

if [ "$(uname -s)" = Linux ]; then
  TMP=$(mktemp)
  cat >"$TMP" <<ENTRY
[Desktop Entry]
Type=Application
Name=Symposium
Comment=Run a software project with a team of AI agents
Exec=$LAUNCHER
Icon=$ROOT/assets/symposium.svg
Terminal=false
Categories=Development;
ENTRY
  $SUDO mkdir -p "$APPS_DIR"
  $SUDO install -m 644 "$TMP" "$DESKTOP"
  rm -f "$TMP"
  echo "$DESKTOP"
fi

say "Looking for agent providers"
FOUND=0
if command -v claude >/dev/null 2>&1; then
  echo "Claude Code (claude): found"
  FOUND=1
else
  echo "Claude Code (claude): not found"
fi
if command -v agy >/dev/null 2>&1; then
  echo "Antigravity (agy): found"
  FOUND=1
else
  echo "Antigravity (agy): not found"
fi
[ "$FOUND" -eq 1 ] || echo "No agent CLI yet. You can still look around with the Mock provider. See SETUP.md, step 2."

say "Done"
case ":$PATH:" in
  *":$BIN_DIR:"*) echo "Start Symposium with:  symposium" ;;
  *)
    echo "Start Symposium with:  $LAUNCHER"
    echo "To type just 'symposium', add $BIN_DIR to your PATH."
    ;;
esac
if [ "$(uname -s)" = Linux ]; then echo "It is also in your applications menu."; fi
echo "Keep this folder where it is: the command runs Symposium from $ROOT"
