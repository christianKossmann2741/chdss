#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
output="$(mktemp -d "${TMPDIR:-/tmp}/chdss-native-tests.XXXXXX")"
trap 'rm -rf "$output"' EXIT
xcrun swiftc -parse-as-library "$root/native/macos/Policy.swift" "$root/test/native-macos-policy.swift" -o "$output/policy"
"$output/policy"
xcrun swiftc -parse-as-library "$root/native/macos/Policy.swift" "$root/native/macos/PCM.swift" "$root/test/native-macos-pcm.swift" -framework CoreAudio -framework CoreMedia -o "$output/pcm"
"$output/pcm"
xcrun swiftc -parse-as-library "$root/native/macos/Policy.swift" "$root/native/macos/PCMWriter.swift" "$root/test/native-macos-writer.swift" -o "$output/writer"
"$output/writer"
# CLI permission tests are opt-in: CI must not request/grant OS capture access.
if [[ "${CHDSS_NATIVE_CLI_TESTS:-0}" == 1 ]]; then
  python3 "$root/test/native-macos-cli.py"
fi
