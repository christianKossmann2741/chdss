#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
arch="${1:-arm64}"
case "$arch" in arm64|x64) ;; *) printf 'Unsupported architecture\n' >&2; exit 1 ;; esac
swift_arch="$arch"
[[ "$arch" != x64 ]] || swift_arch=x86_64
output="$root/native/bin/darwin-$arch"
mkdir -p "$output"
xcrun swiftc -parse-as-library -swift-version 5 -O -target "$swift_arch-apple-macos14.2" \
  "$root/native/macos/Policy.swift" "$root/native/macos/PCM.swift" \
  "$root/native/macos/PCMWriter.swift" "$root/native/macos/Capture.swift" "$root/native/macos/Main.swift" \
  -framework AppKit -framework ScreenCaptureKit -framework CoreMedia -framework CoreGraphics \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$root/native/macos/Info.plist" \
  -o "$output/chdss-audio"
chmod +x "$output/chdss-audio"
codesign --force --sign - --identifier com.christiankossmann.chdss.audio "$output/chdss-audio"
codesign --verify --strict "$output/chdss-audio"
printf 'Built and ad-hoc signed %s\n' "$output/chdss-audio"
