import { connectionPolicy } from './webrtc.js';

/** One viewer owns one transport and one media element. Credentials stay in memory. */
export function createViewer(env = globalThis, options = {}) {
  const { document, location } = env;
  const $ = id => document.getElementById(id);
  const video = $('stream');
  let socket, peer, room, statsTimer, reconnectTimer;
  let mode, disposed = false, transportConnected = false, playing = false;
  let candidates = [], media, generation = 0, retries = 0, signalQueue = Promise.resolve();
  const listeners = [];
  const on = (target, event, handler) => { target.addEventListener(event, handler); listeners.push(() => target.removeEventListener(event, handler)); };
  const show = (id, visible) => $(id).classList.toggle('hidden', !visible);
  const badge = (text, state = 'waiting') => { $('connectionBadge').textContent = text; $('connectionBadge').className = `badge ${state}`; };
  const waiting = (title, message) => { $('emptyTitle').textContent = title; $('emptyMessage').textContent = message; show('emptyState', true); };
  function clearMedia() {
    env.clearInterval(statsTimer); statsTimer = null;
    transportConnected = false; playing = false; media = null;
    video.pause(); video.srcObject = null; video.classList.remove('receiving');
    for (const id of ['playButton', 'muteButton', 'volume', 'pipButton', 'fullscreenButton']) $(id).disabled = true;
    $('stats').textContent = 'No media received'; show('emptyState', true);
  }
  function resetPeer() {
    const old = peer; peer = null;
    if (old) { old.onconnectionstatechange = null; old.ontrack = null; old.onicecandidate = null; old.close(); }
    candidates = []; clearMedia();
  }
  function updateLive() {
    if (transportConnected && playing && media?.getVideoTracks().some(t => t.readyState === 'live' && !t.muted)) badge('Live', 'live');
  }
  function addTrack(track) {
    if (!['audio', 'video'].includes(track.kind)) return;
    media ??= new env.MediaStream();
    // A replacement source must replace, not play beside, the old track.
    for (const old of media.getTracks()) if (old.kind === track.kind && old.id !== track.id) media.removeTrack(old);
    if (!media.getTracks().some(t => t.id === track.id)) media.addTrack(track);
    video.srcObject = media;
    if (media.getVideoTracks().length) {
      video.classList.add('receiving'); show('emptyState', false);
      $('playButton').disabled = false; $('muteButton').disabled = false; $('volume').disabled = false;
      $('pipButton').disabled = !document.pictureInPictureEnabled || typeof video.requestPictureInPicture !== 'function';
      $('fullscreenButton').disabled = !(typeof $('stage').requestFullscreen === 'function' || typeof video.webkitEnterFullscreen === 'function');
    }
    track.addEventListener('ended', () => removeTrack(track));
    track.addEventListener('mute', () => { if (track.kind === 'video') badge('Feed interrupted'); });
    track.addEventListener('unmute', updateLive);
    video.play().catch(() => { badge('Ready to play'); $('playButton').textContent = 'Play with audio'; });
  }
  function removeTrack(track) {
    media?.removeTrack(track);
    if (!media?.getVideoTracks().length) { clearMedia(); transportConnected = Boolean(room); badge('Waiting for broadcast'); waiting('The broadcast is paused.', 'Stay here. The screen will return when your host shares again.'); }
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
        let inbound;
        reports?.forEach(report => { if (report.type === 'inbound-rtp' && (report.kind === 'video' || report.mediaType === 'video')) inbound = report; });
        const size = video.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : 'Waiting for frames';
        let rate = '';
        if (inbound && previous?.id === inbound.id && inbound.timestamp > previous.timestamp && inbound.bytesReceived >= previous.bytesReceived) rate = ` · ${((inbound.bytesReceived - previous.bytesReceived) * 8 / (inbound.timestamp - previous.timestamp) / 1000).toFixed(1)} Mbps`;
        previous = inbound;
        $('stats').textContent = `${size}${rate}`;
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
      else if (['failed', 'disconnected'].includes(current.connectionState)) { badge('Feed interrupted'); show('retryButton', true); }
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
        if (message.type === 'ready') { retries = 0; badge('Waiting for broadcast'); waiting('Your host will be right with you.', 'The screen appears here when your host starts sharing.'); show('retryButton', false); }
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
      badge('Reconnecting'); waiting('Connection interrupted.', 'Trying to reach your host again. You can leave this window open.'); show('retryButton', true);
      reconnectTimer = env.setTimeout(connectLan, Math.min(1000 * 2 ** retries++, 10000));
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
      if (mode === 'relay') { show('unlockPanel', true); badge('Private session'); $('transportLabel').textContent = 'Private session · relay transport'; }
      else { $('transportLabel').textContent = 'Local network · peer-to-peer'; connectLan(); }
    } catch { if (attempt === generation && !disposed) { badge('Server unavailable', 'error'); waiting('Could not reach this server.', 'Check the address and your connection, then try again.'); show('retryButton', true); } }
  }
  function dispose() {
    disposed = true; ++generation; env.clearTimeout(reconnectTimer);
    const old = socket; socket = null; old?.close(); resetPeer(); room?.disconnect(); room = null;
    $('joinPassword').value = ''; listeners.forEach(remove => remove());
  }
  function syncVolume() {
    const muted = video.muted || video.volume === 0;
    $('muteButton').textContent = muted ? 'Unmute' : 'Mute';
    $('muteButton').setAttribute('aria-pressed', String(muted));
    $('volume').value = String(video.muted ? 0 : video.volume);
  }
  async function togglePlayback() {
    if ($('playButton').disabled) return;
    if (video.paused) {
      try { await video.play(); } catch { badge('Playback needs a click'); $('playButton').textContent = 'Play with audio'; }
    } else video.pause();
  }
  function toggleMute() {
    if ($('muteButton').disabled) return;
    video.muted = !(video.muted || video.volume === 0);
    if (!video.muted && video.volume === 0) video.volume = 1;
    syncVolume();
  }
  async function toggleFullscreen() {
    if ($('fullscreenButton').disabled) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if ($('stage').requestFullscreen) await $('stage').requestFullscreen();
      else video.webkitEnterFullscreen?.();
    } catch { $('stats').textContent = 'Fullscreen unavailable in this browser'; }
  }
  on($('playButton'), 'click', togglePlayback);
  on($('muteButton'), 'click', toggleMute);
  on($('volume'), 'input', () => { video.volume = Math.min(1, Math.max(0, Number($('volume').value))); video.muted = video.volume === 0; syncVolume(); });
  on(video, 'volumechange', syncVolume);
  on(video, 'play', () => { $('playButton').textContent = 'Pause'; });
  on(video, 'pause', () => { playing = false; $('playButton').textContent = 'Play with audio'; if (media) badge('Paused'); });
  on(video, 'waiting', () => { playing = false; if (media) badge('Buffering'); });
  on(video, 'playing', () => { playing = true; updateLive(); });
  on($('fullscreenButton'), 'click', toggleFullscreen);
  on(document, 'fullscreenchange', () => { $('fullscreenButton').textContent = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen'; });
  on($('pipButton'), 'click', async () => {
    if ($('pipButton').disabled) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await video.requestPictureInPicture();
    } catch { $('stats').textContent = 'Picture in Picture unavailable in this browser'; }
  });
  on(video, 'enterpictureinpicture', () => { $('pipButton').textContent = 'Exit Picture in Picture'; });
  on(video, 'leavepictureinpicture', () => { $('pipButton').textContent = 'Picture in Picture'; });
  on(document, 'keydown', event => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat || event.isComposing || !$( 'unlockPanel').classList.contains('hidden')) return;
    if (event.target?.closest?.('input, textarea, select, button, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) return;
    const action = { f: toggleFullscreen, m: toggleMute, ' ': togglePlayback }[event.key.toLowerCase()];
    if (action) { event.preventDefault(); return action(); }
  });
  on($('joinForm'), 'submit', join);
  on($('logoutButton'), 'click', leaveRelay);
  on($('retryButton'), 'click', () => {
    env.clearTimeout(reconnectTimer); const old = socket; socket = null; old?.close(); resetPeer();
    if (mode === 'lan') { badge('Reconnecting'); show('retryButton', false); connectLan(); }
    else return start();
  });
  show('unlockPanel', false); show('logoutButton', false); syncVolume();
  on(env, 'beforeunload', dispose);
  return { start, dispose };
}

if (typeof document !== 'undefined') createViewer().start();
