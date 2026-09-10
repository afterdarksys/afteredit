#!/bin/sh
# AfterEdit $EDITOR bridge.
#
# Installed into the terminal session as $EDITOR/$VISUAL/$GIT_EDITOR/
# $KUBE_EDITOR. Hands the file to the GUI and blocks until the tab is closed,
# which is what makes `git commit` and `kubectl edit` work: both read this
# process's exit status to decide whether to apply or abort.
#
# __SESSION_DIR__ is substituted when the file is written out at startup.
set -u

session="__SESSION_DIR__"

if [ "$#" -eq 0 ]; then
  echo "afteredit-edit: no file to edit" >&2
  exit 1
fi

# Take the last argument: editors are called as `editor [options] FILE`, and
# git passes only the path.
for candidate in "$@"; do :; done
file="$candidate"

# The GUI has no idea what the shell's working directory is.
case "$file" in
  /*) ;;
  *) file="$PWD/$file" ;;
esac

if [ ! -e "$file" ]; then
  # git and kubectl create the file before calling us; anything else that does
  # not is a mistake we should not paper over.
  echo "afteredit-edit: $file does not exist" >&2
  exit 1
fi

id="$$-$(date +%s)"
release="$session/release/$id"

if ! mkfifo -m 600 "$release" 2>/dev/null; then
  echo "afteredit-edit: could not create the release pipe; is AfterEdit running?" >&2
  exit 1
fi

# Leaving a pipe behind would wedge the next request that reuses the id.
trap 'rm -f "$release"' EXIT INT TERM

printf '%s\t%s\n' "$id" "$file" >> "$session/requests" || {
  echo "afteredit-edit: AfterEdit is not listening" >&2
  exit 1
}

echo "[AfterEdit] editing $(basename "$file") - close the tab to continue" >&2

# Blocks until the GUI writes an exit code here.
code=$(cat "$release")

case "$code" in
  ''|*[!0-9]*) exit 1 ;;
  *) exit "$code" ;;
esac
