#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="${CHDSS_DATA:-$HOME/.local/share/chdss-relay}"
usage() {
  printf '%s\n' 'CHDSS self-hosted relay (Debian/Linux, Docker + Compose required)' '  bash server/chdss-server.sh start --domain stream.example.com' '  bash server/chdss-server.sh status' '  bash server/chdss-server.sh publisher-key' '  bash server/chdss-server.sh stop' '' 'Point DNS at this VPS first. Ports: 80/443 TCP, 7881 TCP, 7882/3478 UDP.' 'No firewall rules, packages, or existing services are modified.' 'CHDSS_DATA overrides the persistent private configuration directory.'
}
ACTION="${1:-help}"
if [[ "$ACTION" == help || "$ACTION" == --help ]]; then usage; exit 0; fi
if [[ "$(uname -s)" != Linux ]]; then printf '%s\n' 'This server launcher requires Linux (Debian 12/13 recommended).' >&2; exit 1; fi
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  printf '%s\n' 'Install Docker Engine and its Compose plugin first using the official Debian instructions:' 'https://docs.docker.com/engine/install/debian/' 'Then rerun this script. CHDSS does not run a remote root installer.' >&2; exit 1
fi
docker info >/dev/null 2>&1 || { printf '%s\n' 'Cannot access Docker. Start Docker and run as a user with Docker access.' >&2; exit 1; }
mkdir -p "$DATA"
DATA="$(cd "$DATA" && pwd)"
compose() { docker compose -f "$DATA/compose.yml" "$@"; }
case "$ACTION" in
  start)
    [[ "${2:-}" == --domain && -n "${3:-}" && $# -eq 3 ]] || { usage; exit 1; }
    [[ -f "$ROOT/public/vendor/livekit-client.js" ]] || { printf '%s\n' 'Missing browser SDK. Use the released server archive, or run npm ci && npm run build:web from source.' >&2; exit 1; }
    if [[ ! -f "$DATA/compose.yml" ]] || [[ -z "$(compose ps -q 2>/dev/null)" ]]; then
      command -v ss >/dev/null || { printf '%s\n' 'The iproute2 ss utility is required to check port conflicts.' >&2; exit 1; }
      for port in 80 443 7880 7881 41800; do
        if [[ -n "$(ss -H -ltn "sport = :$port")" ]]; then printf 'TCP port %s is already in use. Existing services were left untouched.\n' "$port" >&2; exit 1; fi
      done
      for port in 7882 3478; do
        if [[ -n "$(ss -H -lun "sport = :$port")" ]]; then printf 'UDP port %s is already in use. Existing services were left untouched.\n' "$port" >&2; exit 1; fi
      done
    fi
    docker run --rm --network none -v "$ROOT:$ROOT:ro" -v "$DATA:$DATA" -w "$ROOT" node:22.23.1-alpine node server/configure.js "$DATA" "$3" "$ROOT"
    compose up -d --build --wait --wait-timeout 180
    printf 'Server containers started. Viewer URL: https://%s\n' "$3"
    printf '%s\n' 'Verify HTTPS from another device before sharing. DNS/TLS issuance may take a moment.' 'Retrieve your private publisher key with: bash server/chdss-server.sh publisher-key' 'Enter the URL and that key in the app’s Internet tab. Viewers use the separate generated session password.'
    ;;
  stop|status)
    [[ -f "$DATA/compose.yml" ]] || { printf '%s\n' 'No configured CHDSS server in this data directory.'; exit 1; }
    if [[ "$ACTION" == stop ]]; then compose down; else compose ps; fi
    ;;
  publisher-key)
    [[ -f "$DATA/secrets.json" ]] || { printf '%s\n' 'Start the server first.' >&2; exit 1; }
    docker run --rm --network none -v "$DATA/secrets.json:/config.json:ro" node:22.23.1-alpine node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/config.json')).ownerKey+'\\n')"
    ;;
  *) usage; exit 1 ;;
esac
