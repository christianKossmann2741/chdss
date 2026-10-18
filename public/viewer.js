import { connectionPolicy } from './webrtc.js';
import { FlapBoard, Sparkline, Ticker, Waveform, barcode, boot, clock, formatBitrate, scramble, timecode, typewriter } from './hud.js';

/** One viewer owns one transport and one media element. Credentials stay in memory. */
export function createViewer(env = globalThis, options = {}) {
  const { document, location } = env;
  const $ = id => document.getElementById(id);
  const video = $('stream');
  const stage = $('stage');
  let socket, peer, room, statsTimer, reconnectTimer, toastTimer, waveFrame, wakeLock;
  let mode, disposed = false, transportConnected = false, playing = false;
  let candidates = [], media, generation = 0, retries = 0, signalQueue = Promise.resolve();
  let mediaStartedAt = 0, lastActivity = Date.now(), badgeText = 'Connecting', live = false;
  let latest = {};
  const listeners = [];
  const on = (target, event, handler) => { target.addEventListener(event, handler); listeners.push(() => target.removeEventListener(event, handler)); };
  const show = (id, visible) => $(id).classList.toggle('hidden', !visible);
  const store = {
    get(key) { try { return env.localStorage?.getItem(`chdss-viewer-${key}`) ?? null; } catch { return null; } },
    set(key, value) { try { env.localStorage?.setItem(`chdss-viewer-${key}`, String(value)); } catch { /* Preferences are optional. */ } }
  };
  const fpsFlaps = new FlapBoard($('fpsFlaps'), { length: 2 });
  const wave = new Waveform($('audioWave'), { bars: 18 });
  const chart = new Sparkline($('bitrateChart'), { capacity: 60 });
  const ticker = new Ticker($('ticker'));
  const setState = (id, on) => $(id).setAttribute('data-state', on ? 'on' : 'off');

  function badge(text, state = 'waiting') {
    badgeText = text; live = state === 'live';
    $('connectionBadge').textContent = text; $('connectionBadge').className = `badge ${state}`;
    stage.classList.toggle('playing', live);
    document.title = live ? '● Live · CHDSS' : `${text} · CHDSS`;
  }
  function waiting(title, message) {
    if ($('emptyTitle').textContent !== title) $('emptyTitle').textContent = title;
    typewriter($('emptyMessage'), message);
    show('emptyState', true);
  }
  function toast(text) {
    $('toast').textContent = text; $('toast').classList.add('show');
    env.clearTimeout(toastTimer);
    toastTimer = env.setTimeout(() => $('toast').classList.remove('show'), 1100);
  }
  function setUnmuteChip(kind) {
    show('unmuteChip', Boolean(kind));
    if (kind) $('unmuteLabel').textContent = kind === 'play' ? 'Click to play' : 'Tap to unmute';
    $('unmuteChip').setAttribute('data-kind', kind || '');
  }
  function clearMedia() {
    env.clearInterval(statsTimer); statsTimer = null;
    transportConnected = false; playing = false; media = null; mediaStartedAt = 0; latest = {};
    video.pause(); video.srcObject = null; video.classList.remove('receiving');
    for (const id of ['playButton', 'muteButton', 'volume', 'pipButton', 'fullscreenButton']) $(id).disabled = true;
    $('stats').textContent = 'No media received'; show('emptyState', true); show('lockFrame', false); setUnmuteChip(null);
    stage.classList.remove('idle'); stage.classList.remove('has-media'); fpsFlaps.set(0); wave.clear(); chart.clear(); releaseWake();
    for (const id of ['statRes', 'statFps', 'statBitrate', 'statCodec', 'statLatency', 'statJitter', 'statLoss', 'statDropped']) $(id).textContent = '—';
  }
  function resetPeer() {
    const old = peer; peer = null;
    if (old) { old.onconnectionstatechange = null; old.ontrack = null; old.onicecandidate = null; old.close(); }
    candidates = []; clearMedia();
  }
  function updateLive() {
    if (transportConnected && playing && media?.getVideoTracks().some(t => t.readyState === 'live' && !t.muted)) badge('Live', 'live');
  }
  /** Autoplay with sound first; browsers that refuse get muted playback plus an obvious unmute action. */
  async function autoplay() {
    try { await video.play(); }
    catch (error) {
      // A newer track/load interrupts an older play(); that is not an autoplay refusal.
      if (error?.name === 'AbortError' || !media) return;
      try { video.muted = true; await video.play(); setUnmuteChip('unmute'); }
      catch (retry) { if (retry?.name !== 'AbortError') { badge('Ready to play'); setUnmuteChip('play'); } }
    }
  }
  function addTrack(track) {
    if (!['audio', 'video'].includes(track.kind)) return;
    media ??= new env.MediaStream();
    // A replacement source must replace, not play beside, the old track.
    for (const old of media.getTracks()) if (old.kind === track.kind && old.id !== track.id) media.removeTrack(old);
    if (!media.getTracks().some(t => t.id === track.id)) media.addTrack(track);
    if (video.srcObject !== media) video.srcObject = media;
    if (media.getVideoTracks().length) {
      video.classList.add('receiving'); stage.classList.add('has-media'); show('emptyState', false); show('lockFrame', true);
      $('playButton').disabled = false; $('muteButton').disabled = false; $('volume').disabled = false;
      $('pipButton').disabled = !document.pictureInPictureEnabled || typeof video.requestPictureInPicture !== 'function';
      $('fullscreenButton').disabled = !(typeof stage.requestFullscreen === 'function' || typeof video.webkitEnterFullscreen === 'function');
      mediaStartedAt ||= Date.now();
    }
    track.addEventListener('ended', () => removeTrack(track));
    track.addEventListener('mute', () => { if (track.kind === 'video') { badge('Feed interrupted'); stage.classList.add('stalled'); } });
    track.addEventListener('unmute', () => { stage.classList.remove('stalled'); updateLive(); });
    layoutLock();
    void autoplay();
  }
  function removeTrack(track) {
    media?.removeTrack(track);
    if (!media?.getVideoTracks().length) { clearMedia(); transportConnected = Boolean(room); badge('Waiting for broadcast'); waiting('The broadcast is paused.', 'Stay here. The screen will return when your host shares again.'); }
  }

  /** Bracket the actual picture, not the letterbox. */
  function layoutLock() {
    const frame = $('lockFrame');
    if (!frame.style?.setProperty || typeof stage.getBoundingClientRect !== 'function') return;
    const box = stage.getBoundingClientRect();
    let width = box.width, height = box.height;
    if (video.videoWidth && video.videoHeight && !stage.classList.contains('fill')) {
      const ratio = video.videoWidth / video.videoHeight;
      if (width / height > ratio) width = height * ratio; else height = width / ratio;
    }
    frame.style.setProperty('--lx', `${(box.width - width) / 2}px`);
    frame.style.setProperty('--ly', `${(box.height - height) / 2}px`);
    frame.style.setProperty('--lw', `${width}px`);
    frame.style.setProperty('--lh', `${height}px`);
  }

  function receivers() {
    if (peer) return peer.getReceivers?.() ?? [];
    const list = [];
    for (const participant of room?.remoteParticipants?.values() ?? []) for (const publication of participant.trackPublications.values()) if (publication.track?.receiver) list.push(publication.track.receiver);
    return list;
  }
  /** One animation-frame loop drives the audio bars (~14 Hz) and the clock, idle and ticker (1 Hz). */
  function startLoop() {
    const frame = env.requestAnimationFrame?.bind(env);
    if (!frame || waveFrame !== undefined) return;
    let lastWave = 0, lastHud = 0;
    const tick = now => {
      waveFrame = frame(tick);
      if (now - lastHud >= 1000) { lastHud = now; refreshHud(); }
      if (now - lastWave < 70 || !media) return;
      lastWave = now;
      let level = 0;
      for (const receiver of receivers()) {
        if (receiver.track?.kind !== 'audio') continue;
        for (const source of receiver.getSynchronizationSources?.() ?? []) level = Math.max(level, source.audioLevel ?? 0);
      }
      wave.push(Math.sqrt(level));
    };
    waveFrame = frame(tick);
  }
  function stopWave() {
    if (waveFrame !== undefined) env.cancelAnimationFrame?.(waveFrame);
    waveFrame = undefined;
  }
  async function acquireWake() {
    try { if (!wakeLock && document.visibilityState !== 'hidden') { wakeLock = await env.navigator?.wakeLock?.request('screen'); wakeLock?.addEventListener?.('release', () => { wakeLock = null; }); } } catch { wakeLock = null; }
  }
  function releaseWake() { const lock = wakeLock; wakeLock = null; lock?.release?.().catch?.(() => {}); }

  function refreshHud() {
    const now = Date.now();
    $('timecode').textContent = mediaStartedAt ? timecode((now - mediaStartedAt) / 1000) : clock();
    $('timecodeLabel').textContent = mediaStartedAt ? 'Watching' : 'Local';
    // Hide controls and cursor while watching undisturbed.
    const panelsOpen = !$('statsPanel').classList.contains('hidden') || !$('helpPanel').classList.contains('hidden');
    stage.classList.toggle('idle', playing && !video.paused && !panelsOpen && now - lastActivity > 2800);
    const { size = '—', fps, bitrate, codec, latency, jitter, loss, dropped } = latest;
    ticker.set([
      ['Status', badgeText, live ? 'hot' : ''],
      ['Transport', mode === 'relay' ? 'Relay · SFU · DTLS-SRTP' : 'LAN · peer-to-peer · DTLS-SRTP'],
      ['Picture', size],
      ['Frame rate', fps === undefined ? '—' : `${fps} fps`],
      ['Bitrate', bitrate === undefined ? '—' : formatBitrate(bitrate), bitrate ? 'hot' : ''],
      ['Codec', codec ?? '—'],
      ['Latency', latency === undefined ? '—' : `≈ ${latency} ms`],
      ['Jitter', jitter === undefined ? '—' : `${jitter} ms`],
      ['Loss', loss === undefined ? '—' : `${loss}%`],
      ['Dropped', dropped ?? '—'],
      ['Audio', video.muted ? 'Muted here' : `${Math.round(video.volume * 100)}%`],
      ['Trackers', '0'],
      ['Accounts', 'None']
    ]);
  }

  function startStats() {
    env.clearInterval(statsTimer);
    let previous;
    statsTimer = env.setInterval(async () => {
      try {
        let reports;
        if (peer) reports = await peer.getStats();
        else if (room) {
          for (const participant of room.remoteParticipants.values()) {
            for (const publication of participant.trackPublications.values()) {
              if (publication.track?.kind === 'video' && publication.track.getRTCStatsReport) reports = await publication.track.getRTCStatsReport();
            }
          }
        }
        if (!media) return;
        let inbound, pair;
        reports?.forEach(report => {
          if (report.type === 'inbound-rtp' && (report.kind === 'video' || report.mediaType === 'video')) inbound = report;
          if (report.type === 'candidate-pair' && report.state === 'succeeded' && (report.nominated || report.selected)) pair = report;
        });
        const size = video.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : 'Waiting for frames';
        let rate = '', bitrate;
        const comparable = inbound && previous?.id === inbound.id && inbound.timestamp > previous.timestamp;
        if (comparable && inbound.bytesReceived >= previous.bytesReceived) {
          bitrate = (inbound.bytesReceived - previous.bytesReceived) * 8 / (inbound.timestamp - previous.timestamp) * 1000;
          rate = ` · ${(bitrate / 1_000_000).toFixed(1)} Mbps`;
        }
        $('stats').textContent = `${size}${rate}`;
        const delta = key => comparable ? (inbound[key] ?? 0) - (previous[key] ?? 0) : 0;
        const fps = inbound?.framesPerSecond !== undefined ? Math.round(inbound.framesPerSecond) : undefined;
        const buffer = delta('jitterBufferEmittedCount') > 0 ? delta('jitterBufferDelay') / delta('jitterBufferEmittedCount') * 1000 : undefined;
        const decode = delta('framesDecoded') > 0 ? delta('totalDecodeTime') / delta('framesDecoded') * 1000 : 0;
        const rtt = pair?.currentRoundTripTime;
        const received = delta('packetsReceived'), lost = Math.max(0, delta('packetsLost'));
        const lossRatio = received + lost > 0 ? lost / (received + lost) : undefined;
        latest = {
          size, fps, bitrate,
          codec: inbound?.codecId ? reports.get?.(inbound.codecId)?.mimeType?.split('/')[1] : undefined,
          latency: buffer !== undefined ? Math.round(buffer + decode + (rtt ?? 0) * 500) : undefined,
          jitter: inbound?.jitter !== undefined ? Math.round(inbound.jitter * 1000) : undefined,
          loss: lossRatio !== undefined ? (lossRatio * 100).toFixed(1) : undefined,
          dropped: inbound?.framesDropped
        };
        previous = inbound;
        fpsFlaps.set(fps ?? 0);
        if (bitrate !== undefined) chart.push(bitrate);
        $('lockScore').textContent = `Signal ${(lossRatio === undefined ? 0.99 : Math.min(0.99, 1 - lossRatio)).toFixed(2)}`;
        $('lockTag').textContent = `${size}${fps ? ` · ${fps} fps` : ''}`;
        const text = (id, value) => { if ($(id).textContent !== value) $(id).textContent = value; };
        text('statRes', size); text('statFps', fps === undefined ? '—' : `${fps}`); text('statBitrate', bitrate === undefined ? '—' : formatBitrate(bitrate));
        text('statCodec', latest.codec ?? '—'); text('statLatency', latest.latency === undefined ? '—' : `${latest.latency} ms`);
        text('statJitter', latest.jitter === undefined ? '—' : `${latest.jitter} ms`); text('statLoss', latest.loss === undefined ? '—' : `${latest.loss}%`);
        text('statDropped', String(latest.dropped ?? '—')); text('statTransport', mode === 'relay' ? 'Relay' : 'LAN · P2P');
        refreshHud();
      } catch { /* Stats are optional; a report failure is not a media failure. */ }
    }, 1000);
  }
  const send = message => { if (socket?.readyState === env.WebSocket.OPEN) socket.send(JSON.stringify(message)); };
  function makePeer() {
    resetPeer();
    const current = peer = new env.RTCPeerConnection(connectionPolicy());
    current.onicecandidate = event => { if (current === peer && event.candidate) send({ type: 'signal', payload: { candidate: event.candidate } }); };
    current.ontrack = event => { if (current === peer) addTrack(event.track); };
    current.onconnectionstatechange = () => {
      if (current !== peer) return;
      transportConnected = current.connectionState === 'connected';
      if (transportConnected) { startStats(); updateLive(); }
      else if (['failed', 'disconnected'].includes(current.connectionState)) {
        badge('Feed interrupted'); show('retryButton', true);
        // A failed LAN path heals by renegotiating from a fresh signaling session.
        if (current.connectionState === 'failed' && mode === 'lan') { env.clearTimeout(reconnectTimer); reconnectTimer = env.setTimeout(() => { if (peer === current) retryLan(); }, 2000); }
      }
    };
    return current;
  }
  async function handleSignal(payload) {
    if (!payload) return;
    // An offer can also start a new broadcast on the existing authenticated socket.
    if (payload.description && peer?.remoteDescription) makePeer();
    const current = peer || makePeer();
    if (payload.description) {
      await current.setRemoteDescription(payload.description);
      if (current !== peer) return;
      for (const candidate of candidates) await current.addIceCandidate(candidate);
      candidates = [];
      const answer = await current.createAnswer();
      await current.setLocalDescription(answer);
      if (current === peer) send({ type: 'signal', payload: { description: current.localDescription } });
    }
    if (payload.candidate) {
      if (current.remoteDescription) await current.addIceCandidate(payload.candidate);
      else candidates.push(payload.candidate);
    }
  }
  function connectLan() {
    if (disposed) return;
    let token;
    try { token = decodeURIComponent(location.hash.slice(1)); } catch { token = ''; }
    if (!token) { badge('Pairing code missing', 'error'); waiting('You need an invite link.', 'Open the complete viewer link from your host, including the code after #.'); return; }
    const current = socket = new env.WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/signal`);
    current.onopen = () => { if (current === socket) send({ type: 'hello', role: 'viewer', token }); };
    current.onmessage = event => {
      signalQueue = signalQueue.then(async () => {
        if (current !== socket || disposed) return;
        const message = JSON.parse(event.data);
        if (message.type === 'ready') { retries = 0; badge('Waiting for broadcast'); waiting('Your host will be right with you.', 'The screen appears here the moment your host starts sharing.'); show('retryButton', false); }
        if (message.type === 'signal') await handleSignal(message.payload);
        if (['host-left', 'stream-stopped'].includes(message.type)) { resetPeer(); badge('Waiting for broadcast'); waiting('The broadcast has stopped.', 'Stay here to reconnect automatically when your host shares again.'); }
        if (message.type === 'error') { badge('Connection declined', 'error'); waiting('Could not join this broadcast.', message.message || 'Ask your host for a new invite link.'); }
      }).catch(() => { badge('Connection error', 'error'); waiting('Could not receive the screen.', 'Try reconnecting, or ask your host to restart sharing.'); show('retryButton', true); });
      return signalQueue;
    };
    current.onclose = event => {
      if (current !== socket || disposed) return;
      socket = null; resetPeer();
      if (event.code === 1008) { badge('Invalid pairing code', 'error'); waiting('This invite is no longer valid.', 'Ask your host for a fresh viewer link.'); return; }
      const delay = Math.min(1000 * 2 ** retries++, 10000);
      badge('Reconnecting'); waiting('Connection interrupted.', `Trying to reach your host again in ${Math.round(delay / 1000)}s. You can leave this window open.`); show('retryButton', true);
      reconnectTimer = env.setTimeout(connectLan, delay);
    };
    current.onerror = () => { if (current === socket) badge('Cannot reach host', 'error'); };
  }
  function unlock(title = 'Private session') {
    clearMedia(); badge(title); show('unlockPanel', true); show('logoutButton', false);
    $('joinPassword').value = ''; $('joinButton').disabled = false; $('joinButton').textContent = 'Join private session';
    $('joinPassword').focus();
  }
  async function leaveRelay() {
    ++generation;
    const old = room; room = null;
    unlock('Session left'); $('joinError').textContent = '';
    try { await old?.disconnect(); } catch { /* Local credentials/media are already cleared. */ }
  }
  async function join(event) {
    event?.preventDefault();
    if (mode !== 'relay' || disposed || $('joinButton').disabled) return;
    const password = $('joinPassword').value;
    if (!password) { $('joinError').textContent = 'Enter the password from your host.'; $('joinPassword').focus(); return; }
    const attempt = ++generation;
    $('joinButton').disabled = true; $('joinButton').textContent = 'Joining…'; $('joinError').textContent = '';
    let current;
    try {
      const response = await env.fetch('/api/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }), cache: 'no-store', credentials: 'omit' });
      $('joinPassword').value = '';
      if (attempt !== generation || disposed) return;
      if (!response.ok) throw new Error(response.status === 429 ? 'Too many attempts. Wait a moment, then try again.' : response.status === 401 || response.status === 403 ? 'That password was not accepted. Check with your host.' : 'The session is unavailable. Ask your host to start a new one.');
      const credentials = await response.json();
      if (typeof credentials.token !== 'string' || !credentials.token || typeof credentials.url !== 'string' || !/^wss:\/\//i.test(credentials.url)) throw new Error('The relay returned an invalid connection. Contact your host.');
      const sdk = await (options.loadSDK || (() => import('./vendor/livekit-client.js')))();
      if (attempt !== generation || disposed) return;
      const { Room, RoomEvent } = sdk;
      current = room = new Room({ adaptiveStream: false, dynacast: true });
      const active = () => room === current && attempt === generation && !disposed;
      current.on(RoomEvent.TrackSubscribed, track => { if (active() && track.mediaStreamTrack) addTrack(track.mediaStreamTrack); });
      current.on(RoomEvent.TrackUnsubscribed, track => { if (active() && track.mediaStreamTrack) removeTrack(track.mediaStreamTrack); });
      current.on(RoomEvent.Reconnecting, () => { if (active()) { transportConnected = false; badge('Reconnecting'); } });
      current.on(RoomEvent.Reconnected, () => { if (active()) { transportConnected = true; badge('Waiting for broadcast'); updateLive(); } });
      current.on(RoomEvent.Disconnected, () => {
        if (!active()) return;
        room = null; ++generation; unlock('Session ended'); $('joinError').textContent = 'The connection ended. Enter a current password to rejoin.';
      });
      await current.connect(credentials.url, credentials.token);
      // Keep no app-level token/password references after connection.
      credentials.token = ''; credentials.url = '';
      if (!active()) { await current.disconnect(); return; }
      transportConnected = true; show('unlockPanel', false); show('logoutButton', true);
      badge('Waiting for broadcast'); waiting('You’re in. Waiting for your host.', 'The screen appears as soon as your host starts sharing.');
      if (media?.getVideoTracks().length) show('emptyState', false);
      updateLive(); startStats();
    } catch (error) {
      if (attempt !== generation || disposed) return;
      if (room === current) room = null;
      try { await current?.disconnect(); } catch { /* Leave locally even if transport cleanup fails. */ }
      unlock('Unable to join');
      // Do not echo SDK errors: they may contain a credential-bearing connection URL.
      $('joinError').textContent = current ? 'Could not connect to the media relay. Check your connection and try again.' : error.message;
    } finally {
      if (attempt === generation && !disposed) { $('joinButton').disabled = false; $('joinButton').textContent = 'Join private session'; $('joinPassword').value = ''; }
    }
  }
  async function start() {
    const attempt = ++generation;
    show('retryButton', false); badge('Connecting');
    try {
      const response = await env.fetch('/api/info', { cache: 'no-store', credentials: 'omit' });
      if (attempt !== generation || disposed) return;
      if (response.status === 404) mode = 'lan';
      else if (response.ok) {
        mode = (await response.json()).mode;
        if (!['lan', 'relay'].includes(mode)) throw new Error('Unexpected server response');
      } else throw new Error('Unexpected server response');
      if (attempt !== generation || disposed) return;
      if (mode === 'relay') { show('unlockPanel', true); badge('Private session'); scramble($('transportLabel'), 'Private session · relay transport'); }
      else { scramble($('transportLabel'), 'Local network · peer-to-peer'); connectLan(); }
      refreshHud();
    } catch { if (attempt === generation && !disposed) { badge('Server unavailable', 'error'); waiting('Could not reach this server.', 'Check the address and your connection, then try again.'); show('retryButton', true); } }
  }
  function dispose() {
    disposed = true; ++generation; env.clearTimeout(reconnectTimer); env.clearTimeout(toastTimer); stopWave(); releaseWake();
    const old = socket; socket = null; old?.close(); resetPeer(); room?.disconnect(); room = null;
    $('joinPassword').value = ''; listeners.forEach(remove => remove());
  }

  function syncVolume() {
    const muted = video.muted || video.volume === 0;
    setState('muteButton', muted);
    $('muteButton').setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
    $('muteButton').setAttribute('aria-pressed', String(muted));
    $('volume').value = String(video.muted ? 0 : video.volume);
    $('volume').style?.setProperty('--fill', `${(video.muted ? 0 : video.volume) * 100}%`);
    if (!muted && $('unmuteChip').getAttribute?.('data-kind') === 'unmute') setUnmuteChip(null);
  }
  async function togglePlayback() {
    if ($('playButton').disabled) return;
    if (video.paused) {
      try { await video.play(); setUnmuteChip(video.muted && $('unmuteChip').getAttribute?.('data-kind') ? 'unmute' : null); }
      catch { badge('Playback needs a click'); setUnmuteChip('play'); }
    } else video.pause();
  }
  function toggleMute() {
    if ($('muteButton').disabled) return;
    video.muted = !(video.muted || video.volume === 0);
    if (!video.muted && video.volume === 0) video.volume = 1;
    syncVolume();
  }
  function nudgeVolume(step) {
    if ($('volume').disabled) return;
    video.volume = Math.min(1, Math.max(0, Math.round((video.volume + step) * 20) / 20));
    video.muted = video.volume === 0;
    store.set('volume', video.volume);
    syncVolume(); toast(`Volume ${Math.round(video.volume * 100)}%`);
  }
  async function toggleFullscreen() {
    if ($('fullscreenButton').disabled) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (stage.requestFullscreen) await stage.requestFullscreen();
      else video.webkitEnterFullscreen?.();
    } catch { toast('Fullscreen unavailable in this browser'); }
  }
  async function togglePip() {
    if ($('pipButton').disabled) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await video.requestPictureInPicture();
    } catch { toast('Picture in Picture unavailable'); }
  }
  function setFill(fill) {
    stage.classList.toggle('fill', fill); setState('fitButton', fill);
    $('fitButton').setAttribute('aria-pressed', String(fill)); $('fitButton').setAttribute('aria-label', fill ? 'Fit the whole picture' : 'Fill the frame');
    store.set('fill', fill ? '1' : '0'); layoutLock();
  }
  function togglePanel(id, visible = $(id).classList.contains('hidden'), persist = true) {
    for (const [other, otherButton] of [['statsPanel', 'statsButton'], ['helpPanel', 'helpButton']]) {
      const open = other === id && visible;
      show(other, open); $(otherButton).setAttribute('aria-pressed', String(open));
    }
    if (id === 'statsPanel' && persist) store.set('stats', visible ? '1' : '0');
    if (visible && id === 'statsPanel') chart.draw();
  }
  function activity() { lastActivity = Date.now(); stage.classList.remove('idle'); }

  on($('playButton'), 'click', togglePlayback);
  on($('muteButton'), 'click', toggleMute);
  on($('volume'), 'input', () => { video.volume = Math.min(1, Math.max(0, Number($('volume').value))); video.muted = video.volume === 0; store.set('volume', video.volume); syncVolume(); });
  on(video, 'volumechange', syncVolume);
  on(video, 'play', () => { setState('playButton', true); $('playButton').setAttribute('aria-label', 'Pause'); });
  on(video, 'pause', () => { playing = false; setState('playButton', false); $('playButton').setAttribute('aria-label', 'Play'); stage.classList.remove('idle'); releaseWake(); if (media) badge('Paused'); });
  on(video, 'waiting', () => { playing = false; if (media) badge('Buffering'); });
  on(video, 'playing', () => { playing = true; stage.classList.remove('stalled'); updateLive(); void acquireWake(); });
  on(video, 'resize', layoutLock);
  on(video, 'click', () => {
    activity();
    const kind = $('unmuteChip').getAttribute?.('data-kind');
    if (kind) { video.muted = false; if (!video.volume) video.volume = 1; void togglePlayback(); setUnmuteChip(null); }
    else if (video.paused) void togglePlayback();
  });
  on(video, 'dblclick', toggleFullscreen);
  on($('fullscreenButton'), 'click', toggleFullscreen);
  on(document, 'fullscreenchange', () => { const full = Boolean(document.fullscreenElement); setState('fullscreenButton', full); $('fullscreenButton').setAttribute('aria-label', full ? 'Exit fullscreen' : 'Fullscreen'); layoutLock(); });
  on($('pipButton'), 'click', togglePip);
  on(video, 'enterpictureinpicture', () => { $('pipButton').setAttribute('aria-pressed', 'true'); });
  on(video, 'leavepictureinpicture', () => { $('pipButton').setAttribute('aria-pressed', 'false'); });
  on($('unmuteChip'), 'click', () => { video.muted = false; if (!video.volume) video.volume = 1; setUnmuteChip(null); void video.play().catch(() => setUnmuteChip('play')); syncVolume(); });
  on($('statsButton'), 'click', () => togglePanel('statsPanel'));
  on($('helpButton'), 'click', () => togglePanel('helpPanel'));
  on($('fitButton'), 'click', () => setFill(!stage.classList.contains('fill')));
  on(stage, 'pointermove', activity);
  on(stage, 'pointerdown', activity);
  on(stage, 'focusin', activity);
  on(document, 'visibilitychange', () => { if (document.visibilityState === 'visible' && playing) void acquireWake(); });
  on(document, 'keydown', event => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing || !$('unlockPanel').classList.contains('hidden')) return;
    if (event.target?.closest?.('input, textarea, select, button, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) return;
    const key = event.key.toLowerCase();
    if (event.shiftKey && key !== '?') return;
    if (event.repeat && !['arrowup', 'arrowdown'].includes(key)) return;
    const action = {
      f: toggleFullscreen, m: toggleMute, ' ': togglePlayback, k: togglePlayback, p: togglePip,
      i: () => togglePanel('statsPanel'), '?': () => togglePanel('helpPanel'), z: () => setFill(!stage.classList.contains('fill')),
      arrowup: () => nudgeVolume(0.05), arrowdown: () => nudgeVolume(-0.05),
      escape: () => togglePanel('statsPanel', false)
    }[key];
    if (action) { event.preventDefault(); activity(); return action(); }
  });
  on($('joinForm'), 'submit', join);
  on($('logoutButton'), 'click', leaveRelay);
  function retryLan() {
    env.clearTimeout(reconnectTimer); const old = socket; socket = null; old?.close(); resetPeer();
    badge('Reconnecting'); show('retryButton', false); connectLan();
  }
  on($('retryButton'), 'click', () => {
    if (mode === 'lan') return retryLan();
    env.clearTimeout(reconnectTimer); const old = socket; socket = null; old?.close(); resetPeer();
    return start();
  });
  on(env, 'resize', () => { layoutLock(); chart.draw(); });
  on(env, 'beforeunload', dispose);

  const savedVolume = Number(store.get('volume'));
  if (store.get('volume') !== null && Number.isFinite(savedVolume)) video.volume = Math.min(1, Math.max(0, savedVolume));
  if (store.get('fill') === '1') setFill(true);
  const roomy = env.matchMedia?.('(min-width: 721px)').matches ?? true;
  togglePanel('statsPanel', store.get('stats') === '1' && roomy, false);
  if (env.navigator?.mediaSession && typeof env.MediaMetadata === 'function') {
    try {
      env.navigator.mediaSession.metadata = new env.MediaMetadata({ title: 'Live screen share', artist: 'CHDSS' });
      env.navigator.mediaSession.setActionHandler('play', () => { if (video.paused) void togglePlayback(); });
      env.navigator.mediaSession.setActionHandler('pause', () => { if (!video.paused) void togglePlayback(); });
    } catch { /* Media keys are optional. */ }
  }
  barcode($('ticketBarcode'), `ADMIT-${Math.random().toString(36).slice(2, 8)}`);
  show('unlockPanel', false); show('logoutButton', false); syncVolume(); fpsFlaps.set(0); startLoop();
  return { start, dispose };
}

if (typeof document !== 'undefined') { boot(); createViewer().start(); }
