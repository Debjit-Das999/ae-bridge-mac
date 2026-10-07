#!/usr/bin/env bash
# Installs claude-bridge.jsx into After Effects' Scripts/Startup folder(s) on macOS.
#
# Usage:
#   ./install.sh                      # every "Adobe After Effects*" install in /Applications
#   AE_STARTUP_DIR="/path/to/Scripts/Startup" ./install.sh   # a non-standard install
#
# /Applications is usually writable only with admin rights; if a plain copy is
# denied this script retries with sudo (you'll be asked for your password).

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src="$here/host/claude-bridge.jsx"
[ -f "$src" ] || { echo "Could not find $src" >&2; exit 1; }

targets=()
if [ -n "${AE_STARTUP_DIR:-}" ]; then
  targets+=("$AE_STARTUP_DIR")
else
  shopt -s nullglob
  for dir in "/Applications/Adobe After Effects"*/Scripts/Startup; do
    targets+=("$dir")
  done
  shopt -u nullglob
fi

if [ "${#targets[@]}" -eq 0 ]; then
  echo "No After Effects Scripts/Startup folder found under /Applications." >&2
  echo "If After Effects lives elsewhere, run:" >&2
  echo "  AE_STARTUP_DIR=\"/path/to/Adobe After Effects 20XX/Scripts/Startup\" ./install.sh" >&2
  exit 1
fi

installed=0
for dir in "${targets[@]}"; do
  if [ ! -d "$dir" ]; then
    echo "Skipped (folder not found): $dir"
    continue
  fi
  dest="$dir/claude-bridge.jsx"
  if cp -f "$src" "$dest" 2>/dev/null; then
    echo "Installed to $dest"
    installed=$((installed + 1))
  else
    echo "Permission denied for $dir - retrying with sudo..."
    if sudo cp -f "$src" "$dest"; then
      echo "Installed to $dest"
      installed=$((installed + 1))
    else
      echo "Failed to install to $dest" >&2
    fi
  fi
done

if [ "$installed" -eq 0 ]; then
  echo "Nothing was installed." >&2
  exit 1
fi

cat <<'EOF'

Next steps:
1. In After Effects: Settings (Preferences) > Scripting & Expressions >
   enable "Allow Scripts to Write Files and Access Network".
2. Fully quit and restart After Effects.
3. Check the log for 'claude-bridge initialized (PORT=41890)':
     cat "$TMPDIR/claude-ae-bridge.log" | tail -5
   (After Effects' temp folder is normally the same as $TMPDIR.)
EOF
