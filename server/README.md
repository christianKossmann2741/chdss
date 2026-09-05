# CHDSS self-hosted Internet relay

An optional Internet transport for CHDSS 2. LAN sharing stays independent and enabled; the desktop uploads **one** audio/video feed to a LiveKit SFU, which forwards it to up to 12 remote viewers. No transcoding or recording service is installed.

## Quick start — Debian 12/13 VPS

1. Install [Docker Engine with its Compose plugin](https://docs.docker.com/engine/install/debian/). The launcher deliberately does not install packages, change firewall rules, or stop existing services. Docker access is effectively root access; only trusted administrators should have it.
2. Point a DNS hostname (e.g. `stream.example.com`) at the VPS. Remove incorrect AAAA records. Use **DNS-only**, not a CDN proxy.
3. Allow inbound **TCP 80, 443, 7881** and **UDP 7882, 3478** in the VPS/provider firewall. Never expose **7880** or **41800** publicly.
4. Download `CHDSS-<version>-Debian-Server.tar.gz` and `SHA256SUMS` from the [release page](https://github.com/christianKossmann2741/chdss/releases/latest), verify the archive checksum, and extract it.
5. In the extracted folder:

```bash
bash server/chdss-server.sh start --domain stream.example.com
bash server/chdss-server.sh publisher-key
```

The first command builds the small authentication container, starts LiveKit and Caddy, and lets Caddy provision/renew HTTPS certificates. Node/npm are inside Docker, not installed on Debian. The second prints your **private publishing key**. Never send that key to viewers.

In the desktop app: **Share access → Internet**, enter `https://stream.example.com` and the publisher key, then **Create private session**. Start screen sharing. **Copy invitation** gives you the viewer link and a separate randomly generated session password. A viewer opens the page and enters that password. No accounts.

**Stop sharing** pauses media but keeps the invitation usable. **End Internet session** revokes the password, disconnects viewers, and deletes the room. Creating a replacement session revokes the previous one. LAN viewers are unaffected. A new password is generated for each session.

```bash
bash server/chdss-server.sh status
bash server/chdss-server.sh stop
```

Settings/secrets persist in `~/.local/share/chdss-relay` (override using `CHDSS_DATA`). Stopping removes containers, not credentials or Caddy certificates. Keep that private directory out of backups shared with others. To rotate a compromised publisher key, stop the stack, replace the `ownerKey` value in its private `secrets.json` with 32 cryptographically random bytes encoded as hex, then start again. Never paste that file into an issue.

## Existing web servers

The standard launcher needs unused ports 80/443. It fails on conflicts rather than taking over nginx/Apache/Caddy. If your VPS already serves websites, use your existing HTTPS proxy to forward **all paths and WebSocket upgrades** to `127.0.0.1:41800`; overwrite `X-Forwarded-For` with the actual client address. Run only the `relay` and `livekit` Compose services after reviewing generated configuration. **Do not proxy LiveKit port 7880 directly**: CHDSS's `/livekit` proxy checks the current room on every connection, so revoked JWTs cannot recreate rooms.

Never turn off TLS checks in the desktop or expose plain HTTP to Internet viewers. A real hostname is required by the standard automatic-certificate setup. See Caddy's production certificate requirements if ACME fails.

## Security and limits

- Private publisher key: 256 random bits, stored in a mode-0600 file. Per-session viewing password: 192 random bits; only its SHA-256 digest is retained in server memory. A fast hash is appropriate here because the password is generated at high entropy, not human-chosen.
- Viewer JWTs last five minutes for admission, grant subscribe-only access, and cannot publish media/data or administer rooms. Already-connected viewers can remain until session closure or expiry. The proxy additionally verifies the active room and issued identities; stopping/replacing the session invalidates admission immediately even for unexpired JWTs. Tokens in the underlying WebRTC signaling protocol are not account credentials; do not enable proxy URL/access logs that might record them.
- Session lifetime is capped at 12 hours. A process restart forgets the password and deletes orphan CHDSS rooms before opening the listener. The LiveKit instance is dedicated to CHDSS, not shared with unrelated products.
- Limits: one broadcaster, 12 admitted viewers; bounded HTTP bodies/headers, timeouts, concurrent sockets, per-IP and global attempt budgets. Unused viewer admissions are reserved for five minutes, so repeatedly reconnecting can temporarily exhaust capacity. Rate limiting reduces abuse; it is not protection against volumetric DDoS.
- Caddy is the only public HTTP endpoint. Authentication and LiveKit administration bind to loopback. Only signaling paths are forwarded through the authentication service. The launcher uses host networking and is Linux-specific.
- Traffic is encrypted via HTTPS/WSS and WebRTC DTLS-SRTP. **This is not end-to-end encryption against the VPS operator**: the SFU is a trusted media endpoint. Anyone operating/compromising it can potentially inspect the media. No recording, analytics, accounts, or cloud service is configured by CHDSS.
- WebRTC uses UDP, with TCP/7881 fallback and authenticated TURN/UDP. **TURN-over-TLS on TCP/443 is not included**; highly restrictive corporate networks may still block playback. Do not promise connectivity on every network. Bandwidth and cost grow with remote viewers at the VPS.
- LAN invitations remain separate HTTP/fragment-token capabilities for trusted private LANs. Do not forward the desktop's LAN port to the Internet.

## Troubleshooting

- **Port conflict:** use another VPS or integrate your existing reverse proxy; CHDSS does not stop it for you.
- **Page works, stream does not:** verify 7881/TCP, 7882/UDP and 3478/UDP at both OS and provider firewalls. Check the VPS public IP is correctly detected. Avoid CDN HTTP-only proxies.
- **Session unavailable:** check `status`. The relay does not start accepting logins until LiveKit is ready.
- **No audio:** play a known sound at the broadcaster and watch the meter. Native OS permissions are separate from relay transport. System audio includes Discord; per-app exclusion is not implemented.
- **Upgrade:** stop the old stack, extract a new server release, and run its launcher with the same `CHDSS_DATA` and domain. Existing session passwords are intentionally invalidated. Image tags and npm dependencies are pinned in each release; review updates regularly.

Developer verification: root `npm ci`, `npm ci --prefix server`, `npm run build:web`, `npm test`, and `npm run smoke` (Docker + Playwright Chromium). The smoke test uses generated canvas/audio tracks and a real LiveKit server; it proves transport, not native OS capture or public-VPS firewall reachability.
