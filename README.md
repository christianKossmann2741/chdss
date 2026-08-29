# Christian's Handy Dandy Screen Share

**CHDSS** is a private, low-latency screen-and-audio sharing app for a local network. Run `chdss` on a Mac or Windows PC, choose a screen or window, and open the generated link in a modern browser. It behaves like a deliberately smaller Discord screen share: one host, multiple viewers, WebRTC transport, synchronized video/audio, fullscreen, and browser Picture-in-Picture where supported.

## What it does

- Captures a selected screen or window through Electron/Chromium
- Requires an audio track before broadcasting, preventing accidental silent shares
- Streams peer-to-peer over LAN WebRTC; media does not pass through a cloud service
- Uses Opus stereo at 48 kHz with in-band forward-error correction and WebRTC A/V timestamps
- Offers 720p, 1080p, 1440p, or native resolution at 30/60 FPS
- Supports multiple browser viewers, live bitrate/resolution stats, fullscreen, and Picture-in-Picture
- Protects each run with a random 192-bit pairing token kept in the URL fragment (not HTTP logs)
- Uses no tracker, account, telemetry, STUN server, or TURN relay

## Requirements

- macOS 14.2 or newer, or Windows 11
- Node.js 20 or newer for source installation; the Windows portable build is self-contained
- Host and viewers on the same LAN/VLAN with client-to-client traffic allowed
- A current Chromium, Edge, Firefox, or Safari browser; PiP depends on that browser's support

## Install

Clone or download this repository first.

### macOS

```bash
./install.sh
chdss
```

The default locations are `~/.local/share/chdss` and `~/.local/bin/chdss`. Override them with `CHDSS_HOME` and `CHDSS_BIN_DIR`. If `~/.local/bin` is not on PATH, the installer prints the exact line to add.

On first use, macOS asks for **Screen & System Audio Recording** permission. Grant it to Electron/CHDSS, then restart `chdss`.

### Windows 11 (PowerShell)

For the portable edition, download `CHDSS-*-Windows-Portable.exe` from the latest GitHub release and run it directly. It includes Electron and Node.js, requires no npm, Git, administrator access, PATH changes, or uninstaller, and can be moved or deleted as a single file. Electron may still create ordinary temporary files and Chromium cache data while running. Windows SmartScreen may warn because the executable is not code-signed; use **More info → Run anyway** only if it came from this repository.

The source installer remains available for development:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install.ps1
chdss
```

The installer uses `%LOCALAPPDATA%\CHDSS`, creates `%LOCALAPPDATA%\CHDSS-command\chdss.cmd`, and adds only that command directory to the user PATH. Open a new terminal after installation. If Windows Firewall prompts, allow **Private networks** only.

## Use

1. Run `chdss` on the computer whose screen will be shared.
2. Choose quality, frame rate, and bitrate. Start with **1080p / 60 FPS / 8 Mbps** on wired or strong Wi-Fi; use **720p / 30 FPS / 2.5–5 Mbps** for a less stable connection.
3. Select the screen or window in CHDSS.
4. Click **Start sharing**.
5. Confirm the host's green audio meter moves. CHDSS refuses to start if the browser supplies no audio track.
6. Send the viewer link only to people on the same local network. Anyone holding the current link can watch until CHDSS exits.
7. On the viewer, click **Play with audio** if browser autoplay policy muted or paused the feed. Use **Picture in Picture** when enabled.

The pairing code changes every time the app starts. Closing CHDSS stops the HTTP/signaling server and every media peer.

## Audio reliability

CHDSS requests stereo 48 kHz system audio, disables microphone-oriented echo cancellation/noise suppression/automatic gain, configures Opus stereo with forward-error correction, gives audio high network priority, and keeps audio and video inside the same WebRTC connection for synchronization. The host UI shows both the captured track and a live level meter.

No application can guarantee perfect audio over arbitrary Wi-Fi, drivers, browser versions, or hardware. CHDSS instead fails visibly when no audio track exists and exposes enough diagnostics to catch the common failure before sharing the link. For lowest delay and cleanest audio, use Ethernet or 5/6 GHz Wi-Fi and avoid saturating the LAN.

## Network and security model

CHDSS listens on all local interfaces on TCP port `41730` by default. Set another port before launch:

```bash
CHDSS_PORT=41800 chdss
```

PowerShell:

```powershell
$env:CHDSS_PORT=41800; chdss
```

Media uses direct WebRTC host candidates only—there are deliberately no public ICE servers—so CHDSS does not traverse NAT and is not intended for internet sharing. Signaling messages are size-limited and role-validated. The viewer link uses HTTP because LAN devices generally cannot trust an ad-hoc certificate; therefore use CHDSS only on a trusted private LAN. The random pairing token prevents casual discovery, not a hostile network administrator performing active interception.

## Uninstall

macOS:

```bash
~/.local/share/chdss/uninstall.sh
```

Windows PowerShell:

```powershell
& "$env:LOCALAPPDATA\CHDSS\uninstall.ps1"
```

## Development

```bash
npm ci
npm test
npm run check
npm start
```

The test suite covers configuration, secure pairing, signaling lifecycle and routing, static-file privacy, WebRTC bitrate/audio policy, CLI behavior, and installer invariants.

## License

MIT
