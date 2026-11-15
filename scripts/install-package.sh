#!/usr/bin/env sh
# Installs the Symposium package that fits this computer.
#
# Put this file in the folder with the packages you downloaded, then run:
#
#   sh install.sh             says which package fits, and installs it after you say yes
#   sh install.sh --print     only says which package fits and how to install it
#   sh install.sh --yes       installs without asking
#
# Your data (~/.symposium) and your projects are never touched.
set -eu

DIR=$(cd "$(dirname "$0")" && pwd)
MODE=ask
for arg in "$@"; do
  case "$arg" in
    --print) MODE=print ;;
    --yes | -y) MODE=yes ;;
    -h | --help)
      sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

from_source() {
  cat <<TEXT

$1

You can still run Symposium from its source code. You need Node.js 22 or newer and git:

  git clone <the Symposium repository>
  cd symposium
  scripts/install.sh
TEXT
  exit 1
}

SYSTEM=$(uname -s)
MACHINE=$(uname -m)
case "$SYSTEM" in
  Linux) ;;
  Darwin) from_source "This is a Mac. There is no Symposium package for macOS yet." ;;
  *)
    cat <<TEXT

This looks like Windows ($SYSTEM). Symposium runs on Windows through WSL:

  1. In PowerShell, as administrator:  wsl --install
     Restart when asked, and finish setting up Ubuntu.
  2. Open the Ubuntu terminal, go to the folder with these files and run:  sh install.sh
  3. Start it there with:  symposium
     The page opens in your Windows browser.
TEXT
    exit 1
    ;;
esac

NAME=Linux
ID=
ID_LIKE=
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  NAME=${PRETTY_NAME:-${NAME:-Linux}}
fi
WSL=
if grep -qi microsoft /proc/version 2>/dev/null; then WSL=" under WSL on Windows"; fi
echo "This computer: $NAME$WSL ($MACHINE)"

[ "$MACHINE" = x86_64 ] ||
  from_source "The packages are for Intel and AMD computers (x86_64). This one is $MACHINE."

# Which family of Linux: the ones that install .deb files, or the ones that install .rpm files.
KIND=
case " $ID $ID_LIKE " in
  *" debian "* | *" ubuntu "*) KIND=deb ;;
  *" fedora "* | *" rhel "* | *" centos "* | *" suse "* | *" opensuse "*) KIND=rpm ;;
esac
if [ -z "$KIND" ]; then
  if command -v dpkg >/dev/null 2>&1; then
    KIND=deb
  elif command -v rpm >/dev/null 2>&1; then
    KIND=rpm
  else
    from_source "This Linux installs neither .deb nor .rpm packages."
  fi
fi

if [ "$KIND" = deb ]; then
  PATTERN='symposium_*_amd64.deb'
  WHO="Debian, Ubuntu and relatives"
else
  PATTERN='symposium-*.x86_64.rpm'
  WHO="Fedora, RHEL, openSUSE and relatives"
fi
# The newest one, if several versions are in the folder.
FILE=$(find "$DIR" -maxdepth 1 -name "$PATTERN" | sort -V | tail -n 1)
if [ -z "$FILE" ]; then
  echo
  echo "The package for $WHO is the one named like $PATTERN"
  echo "It is not in $DIR. Download it into that folder and run this again."
  exit 1
fi
echo "The package that fits: $(basename "$FILE")  (for $WHO)"

SUDO=sudo
[ "$(id -u)" -eq 0 ] && SUDO=
if [ "$KIND" = deb ]; then
  INSTALL="$SUDO apt install -y $FILE"
  REMOVE="sudo apt remove symposium"
elif command -v dnf >/dev/null 2>&1; then
  INSTALL="$SUDO dnf install -y $FILE"
  REMOVE="sudo dnf remove symposium"
elif command -v zypper >/dev/null 2>&1; then
  INSTALL="$SUDO zypper --non-interactive install --allow-unsigned-rpm $FILE"
  REMOVE="sudo zypper remove symposium"
else
  INSTALL="$SUDO rpm -i $FILE"
  REMOVE="sudo rpm -e symposium"
fi
echo "To install it:  $INSTALL"

if [ "$MODE" = print ]; then exit 0; fi
if [ "$MODE" = ask ]; then
  if [ ! -t 0 ]; then
    echo "Run that command, or run this script again with --yes."
    exit 0
  fi
  printf 'Install it now? [y/N] '
  read -r answer
  case "$answer" in
    y | Y | yes | Yes) ;;
    *)
      echo "Nothing was installed."
      exit 0
      ;;
  esac
fi

$INSTALL

cat <<TEXT

Symposium is installed.
  Start it:   symposium          (or find Symposium in your applications menu)
  Stop it:    symposium stop
  Remove it:  $REMOVE
You also need an agent program, such as Claude Code. The first screen tells you what it found.
TEXT
