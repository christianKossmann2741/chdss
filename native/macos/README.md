# macOS filtered audio

The bundled `chdss-audio` helper uses ScreenCaptureKit application-inclusion filters. Electron supplies video separately. Capture stdout contains only interleaved float32 little-endian, 48 kHz, two-channel PCM; JSON lifecycle messages go to stderr. No microphone is captured.

## Build and tests

Requirements for building: Xcode Command Line Tools with a current SDK, Swift compiler, macOS 14.2 or later. Portable application users need no compiler.

```sh
bash native/macos/build.sh arm64
bash native/macos/test.sh
python3 test/native-macos-cli.py
native/bin/darwin-arm64/chdss-audio --list
```

The build embeds `Info.plist` usage descriptions and ad-hoc signs the executable. Tests compile/run native policy, CoreMedia packed/planar PCM conversion, and generation-gated atomic pipe writes. CLI tests accept a visible permission error as fail-closed behavior, not as proof of native audio isolation. They never grant/reset recording permission. CI excludes permission-sensitive CLI tests unless `CHDSS_NATIVE_CLI_TESTS=1`.

## Audio policy

- `--source window:123:0`: resolves CGWindowID 123 to its owning application and captures that application. Other windows/tabs in the same app may also be audible. Explicit Discord-window selection includes that application's audio; CHDSS self-capture is refused.
- `--source screen:0:0`: selects a display from its native ID or Electron display index and captures the allowlisted applications' audio, including off-screen application audio. Applications identified as Discord/Discord PTB/Canary/development, their app helpers, and CHDSS are excluded by application name, bundle identifier, executable path, and parent PID.
- The filter is an **inclusion snapshot**, not a system mix with a mutable blacklist. New applications are not captured until admitted by the next filtered configuration. A newly launched Discord app is never admitted. NSWorkspace launch/termination events close the PCM gate; the helper refreshes at 250 ms intervals. Reconfiguration can briefly interrupt sound.
- A disappeared window, changed owner, invalid format, permission denial, stream failure, or broken pipe stops capture. There is no unfiltered fallback.
- PCM pipe writes are nonblocking/frame-aligned; overload drops chunks rather than creating unbounded delay. Parent IPC and renderer queues are also bounded.
- Stdin EOF and SIGINT/SIGTERM/SIGHUP stop the helper. Stale stream-generation callbacks cannot reopen a stopped stream.

ScreenCaptureKit filters audio at application granularity, not an individual tab/window. Discord in a browser cannot be separately identified. Use the native Discord desktop app while sharing.

## Permission and signing

Grant CHDSS Screen & System Audio Recording access and restart it. The packaged app is ad-hoc signed, not notarized. Replacing it changes the code signature, so an old enabled privacy entry can coexist with a denied replacement. If necessary remove the old entry and add the new `.app`. A helper/source launch may be attributed to the parent app or terminal. The helper deliberately refuses to bypass or reset TCC.

## Real-machine acceptance gate

Policy/conversion tests and a successfully compiled binary do not prove the ScreenCaptureKit audio association on a particular macOS version. Before calling native isolation verified:

1. Play distinct test tones in two independent applications and Discord.
2. Share one application's window; confirm only that application's tone is present in the decoded viewer audio.
3. Share a display; confirm both ordinary application tones are present and the Discord tone is absent.
4. Start/restart Discord during capture and repeat the absence check.
5. Close the selected window; confirm sharing stops. Stop/re-share and verify helper cleanup.

On the development Mac, permission-sensitive testing returned a JSON recording-permission denial and zero PCM. The packaged app launched, rendered the controls, and exposed its healthy signaling server, but real native audio-isolation acceptance remains outstanding. The release is therefore a pre-release.
