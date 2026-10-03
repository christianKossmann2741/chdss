# Windows filtered audio

The bundled x64 `chdss-audio.exe` uses WASAPI **process-loopback include-tree activation**. It never captures an endpoint-wide mix and never falls back to one. Minimum Windows build: 20348; the portable Electron application targets Windows 11.

## Build

Target-machine compiler requirements (not needed by portable users): Visual Studio 2022 C++ Build Tools, Windows SDK, CMake.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File native/windows/build.ps1
native/bin/win32-x64/policy-tests.exe
```

CMake uses `/MT` on MSVC; llvm-mingw cross-builds statically link C++ support. Output imports Windows system/UCRT DLLs only, with no separately installed C++ runtime. The build also emits `chdss-test-tone.exe`, used only by native acceptance tests and not bundled in the application.

Cross-build on a Mac with an extracted llvm-mingw toolchain:

```sh
LLVM_MINGW=/absolute/path/to/llvm-mingw python3 native/windows/build-cross.py
```

The cross-build first compiles and executes the same C++ policy tests on the host. That validates policy/mixing logic, not Windows WASAPI execution. Native CI compiles on Windows and runs the C++ policy tests too.

## Protocol and scope

- `--list`: stdout JSON containing actual windows, decimal native window IDs, owning PIDs, resolved application roots, and executable paths.
- `--source window:123:0`: HWND 123 determines the selected owning application. Same-executable-path ancestors with trustworthy creation times resolve its application root, so browser/Electron audio utility siblings are captured without broadening to Explorer or launchers. This is **application process-tree audio**, not general per-window/per-tab audio isolation.
- `--source screen:0:0`: enumerates active render sessions and captures only allowed application roots. Discord desktop executables/descendants and CHDSS are excluded. Overlapping trees are deduplicated before timestamp-aligned mixing. Unknown/protected/ambiguous sessions and system-sound sessions are omitted rather than captured with an unsafe fallback.
- Capture stdout: raw interleaved float32 little-endian stereo PCM at 48 kHz. Windows is explicitly requested to perform conversion/remixing to that format. JSON `ready` and `error` messages go to stderr.
- Process identities include executable path and creation time. Exclusion history follows Discord children across parent exit/PID reuse. New allowed sessions are discovered about every 250 ms; process-tree safety is checked before each output quantum. Trees containing unknown or excluded descendants are not admitted.
- A 200 ms timestamp quarantine plus bounded output/worklet buffering favors safe refresh over the lowest possible delay. This adds latency compared with direct Electron loopback.
- Closing/replacing the selected window, application exit, activation/format failure, or a consumer falling behind stops capture. Stdin EOF, CTRL_BREAK/console shutdown and signals clean up native capture. No microphone is captured.

Discord hosted in a browser is indistinguishable from other audio in the same browser process tree. Use the Discord desktop application while sharing. Selecting Discord itself as the window intentionally selects its application audio.

## Native acceptance tests

Run on a Windows machine with an active audio output device:

```powershell
py test/native-windows-isolation.py --bin-dir native/bin/win32-x64 --require-native --json-report native/windows/build-vs/isolation.json
```

The harness uses real WASAPI-rendered sine tones from independent test executables and verifies spectral presence/absence in actual captured PCM. It covers selected-app audio siblings versus unrelated apps, Discord/variants/children exclusion, new allowed and excluded processes while sharing, stdin EOF during startup, invalid sources, and CTRL_BREAK cleanup. The Discord-labelled executables exercise the process identity policy; this is separate from manually testing the real Discord client.

Without `--require-native`, non-Windows hosts report skipped tests with `nativeAudioVerified:false`. Skips are not a passing native-capture gate. The development Windows PC was unreachable over SSH, so no physical Windows audio-isolation run was completed for this pre-release.
