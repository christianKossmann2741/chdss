# Christian's Handy Dandy Screen Share

**CHDSS 2** is a private screen-and-audio sharing studio for Mac and Windows. Run the self-contained app, choose a screen or window, and invite browser viewers. **LAN is the default. Internet sharing is an explicit option through your own VPS**, with a random session password and no viewer accounts.

## What it does

- Captures a selected screen or window through Electron/Chromium
- Refuses accidental silent capture when system audio is requested; offers an explicit video-only mode
- Streams peer-to-peer on LAN, or uploads one WebRTC feed to your own LiveKit forwarding server for Internet viewers
- Uses Opus stereo at 48 kHz with in-band forward-error correction and WebRTC A/V timestamps
- Offers 720p, 1080p, 1440p, or native resolution at 30/60 FPS
- Supports multiple browser viewers, live bitrate/resolution stats, fullscreen, and Picture-in-Picture
- Protects each run with a random 192-bit pairing token kept in the URL fragment (not HTTP logs)
- Uses no trackers, accounts, telemetry, or third-party cloud service; LAN uses no ICE servers, Internet mode uses your server's ICE/TURN transport
- Adds balanced/motion/detail/economy presets, source refresh, stream mute, elapsed time, and keyboard playback controls
- Includes native Mac menus, a custom app icon, protected desktop IPC, and sleep prevention while sharing

## Requirements

- macOS 14.2 or newer, or Windows 11
- Node.js 20 or newer for source installation; the packaged Windows and macOS builds are self-contained
- LAN: host and viewers on the same LAN/VLAN with client-to-client traffic allowed
- Internet: your own Linux VPS, DNS hostname, Docker + Compose, and open media ports (see [server guide](server/README.md))
- A current Chromium, Edge, Firefox, or Safari browser; PiP depends on that browser's support

## Install

Download the portable applications from the [latest release](https://github.com/christianKossmann2741/chdss/releases/latest). No source checkout or Node/npm is needed to run either desktop download. `SHA256SUMS` accompanies each release.

### macOS

Download `CHDSS-*-macOS-arm64.zip`, extract `CHDSS.app`, and launch it (moving it to Applications is optional). This is an **Apple Silicon** application, not an Intel/universal build. It is ad-hoc signed but **not Developer ID signed or notarized**. macOS may require Privacy & Security → Open Anyway; only approve an app whose source and checksum you trust. Replacing an ad-hoc-signed build can require recording permission to be granted again.

The source installer remains available for development:

```bash
./install.sh
chdss
```

The default locations are `~/.local/share/chdss` and `~/.local/bin/chdss`. Override them with `CHDSS_HOME` and `CHDSS_BIN_DIR`. If `~/.local/bin` is not on PATH, the installer prints the exact line to add.

Allow **CHDSS** in System Settings → Privacy & Security → **Screen & System Audio Recording**, then fully quit and reopen it. Electron 44 uses Core Audio taps for system audio on modern macOS, with separate authorization; a granted screen permission does not prove system-audio access. The packaged app includes the required audio usage description. Source launches can use Electron/the terminal's permission identity instead of CHDSS.

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

1. Open the portable app on the computer whose screen will be shared.
2. Start with **Balanced (1080p / 30 FPS / 5 Mbps)**. Use **Economy (720p / 30 FPS / 2.5 Mbps)** for less stable connections, **Motion** for 60 FPS, or **Detail** for text. Bitrate is a cap, not a measured speed.
3. Select the screen or window in CHDSS.
4. Click **Start sharing**.
5. Play a sound and confirm the audio meter moves. If audio is requested but the OS supplies no audio track, CHDSS refuses to silently downgrade. Uncheck **Include system audio** when you intentionally want video only. A live track with no sound is not proof of working loopback.
6. Send the viewer link only to people on the same local network. Anyone holding the current link can watch until CHDSS exits.
7. On the viewer, click **Play with audio** if browser autoplay policy muted or paused the feed. Use **Picture in Picture** when enabled.

The pairing code changes every time the app starts. Closing CHDSS stops the HTTP/signaling server and every media peer.

### Optional Internet sharing

Download and extract `CHDSS-*-Debian-Server.tar.gz` on your VPS, then run:

```bash
bash server/chdss-server.sh start --domain stream.example.com
bash server/chdss-server.sh publisher-key
```

DNS must point to the VPS first. Docker Engine + Compose are prerequisites; Node/npm run inside containers. The launcher does not install host packages, modify firewalls, or replace existing web servers. See the [complete server setup, required ports, security model, and reverse-proxy integration](server/README.md).

In CHDSS, choose **Share access → Internet**, enter your HTTPS server origin and private publisher key, then create a session. Share the **viewer link and generated session password**, never the publishing key. LAN remains available independently. **Stop sharing** pauses media; **End Internet session** revokes access. Sessions expire after 12 hours and support up to 12 remote viewers. Restarting/replacing a session generates a new password. If the server cannot confirm revocation, the app warns you rather than claiming success.

### Keyboard controls

- Desktop: **Cmd/Ctrl+Shift+S** starts/stops sharing; **Cmd/Ctrl+R** refreshes sources.
- Viewer: **Space** plays/pauses, **M** mutes, **F** enters/exits fullscreen. Shortcuts do not fire while typing a password.

## Audio reliability

CHDSS requests stereo 48 kHz system audio, disables microphone-oriented echo cancellation/noise suppression/automatic gain, configures Opus stereo with forward-error correction, gives audio high network priority, and keeps audio and video inside the same WebRTC connection for synchronization. The host UI shows both the captured track and a live level meter.

No application can guarantee perfect audio over arbitrary Wi-Fi, drivers, browser versions, or hardware. CHDSS instead fails visibly when no audio track exists and exposes enough diagnostics to catch the common failure before sharing the link. For lowest delay and cleanest audio, use Ethernet or 5/6 GHz Wi-Fi and avoid saturating the LAN.

The current Electron loopback backend captures the complete system-output mix, including voice-chat applications such as Discord. Per-application exclusion requires native process-audio capture on each operating system and is not currently available; use headphones and avoid monitoring your own shared stream when a voice call is active.

For Mac troubleshooting, a documented ScreenCaptureKit compatibility backend can be selected before starting the packaged executable: `CHDSS_MAC_AUDIO=screencapturekit /path/to/CHDSS.app/Contents/MacOS/CHDSS`. This is an alternative capture backend, not a permission bypass. Do not assume it fixes every OS/driver issue. Quit the existing instance before changing it.

## Network and security model

CHDSS listens on all local interfaces on TCP port `41730` by default. Set another port before launch:

```bash
CHDSS_PORT=41800 chdss
```

PowerShell:

```powershell
$env:CHDSS_PORT=41800; chdss
```

**LAN mode** uses direct WebRTC host candidates only. Its viewer invitation cannot authenticate as the broadcaster: publishing uses a distinct secret restricted to loopback. Signaling is size/rate-limited with authentication deadlines. LAN viewer links use HTTP; therefore use them only on a trusted private network. The token prevents casual discovery, not active interception by a hostile network administrator. Never forward the desktop's port to the Internet.

**Internet mode** uses HTTPS/WSS and DTLS-SRTP to a trusted, self-hosted SFU. Passwords are generated with cryptographic randomness, viewers receive subscribe-only short-lived admission tokens, and the signaling proxy checks active-session membership. **The VPS is trusted with the media; this is not end-to-end encryption against its operator.** No recording service is included. UDP and TCP/7881 fallback are supported, plus authenticated TURN/UDP; restrictive networks that require TURN/TLS over port 443 may still block media. Server bandwidth/cost scales with viewers.

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
npm ci --prefix server
npm test
npm run check
npm start
npm run dist:win
npm run dist:mac
npm run dist:server
```

The test suite covers pairing-role isolation, malformed inputs, relay password revocation, least-privilege tokens, rate limits, startup/cleanup, UI controls, and packaging. `npx playwright install chromium && npm run smoke` exercises the real browser host/viewer and a Docker LiveKit SFU using deterministic canvas/audio tracks. Synthetic transport verification does **not** establish native OS loopback capture or public-VPS firewall reachability. `node scripts/verify-mac.js` launches the built Mac bundle and tests native screen capture when permissions permit.

## License

MIT
