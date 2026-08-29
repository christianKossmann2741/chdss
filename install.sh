#!/usr/bin/env bash
set -euo pipefail

[[ "$(uname -s)" == "Darwin" ]] || { echo "CHDSS: install.sh supports macOS. Use install.ps1 on Windows." >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "CHDSS: Node.js 20+ is required (https://nodejs.org)." >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "CHDSS: npm is required." >&2; exit 1; }
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || { echo "CHDSS: Node.js 20 or newer is required." >&2; exit 1; }

source_dir="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app_dir="${CHDSS_HOME:-$HOME/.local/share/chdss}"
bin_dir="${CHDSS_BIN_DIR:-$HOME/.local/bin}"
stage="$(mktemp -d "${TMPDIR:-/tmp}/chdss-install.XXXXXX")"
trap 'rm -rf "$stage"' EXIT

for item in package.json package-lock.json src public bin LICENSE README.md uninstall.sh; do
  [[ -e "$source_dir/$item" ]] && cp -R "$source_dir/$item" "$stage/"
done
(
  cd "$stage"
  npm ci --omit=dev --no-audit --no-fund
)
mkdir -p "$(dirname "$app_dir")" "$bin_dir"
rm -rf "$app_dir"
mv "$stage" "$app_dir"
trap - EXIT
chmod +x "$app_dir/bin/chdss.js"
cat >"$bin_dir/chdss" <<EOF
#!/usr/bin/env bash
exec node "$app_dir/bin/chdss.js" "\$@"
EOF
chmod +x "$bin_dir/chdss"

printf "Installed Christian's Handy Dandy Screen Share.\n"
printf "Command: %s/chdss\n" "$bin_dir"
if [[ ":$PATH:" != *":$bin_dir:"* ]]; then
  printf "Add this to your shell profile, then open a new terminal:\n  export PATH=\"%s:\$PATH\"\n" "$bin_dir"
else
  printf "Run: chdss\n"
fi
printf "On first share, macOS will request Screen & System Audio Recording permission.\n"
