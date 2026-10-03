import { connectionPolicy, preferOpusStereo, tuneSender } from './webrtc.js';
import { captureOptions, presets, relayOrigin, validateCapture } from './broadcast.js';
import { RelayPublisher } from './remote.js';
import { FilteredAudio } from './filtered-audio.js';

let token;
const peers = new Map();
const waitingViewers = new Set();
let socket;
let stream;
let filteredAudio;
let shareGeneration = 0;
let audioLabel = 'Filtered audio';
let meterContext;
let meterFrame;
const $ = id => document.getElementById(id);
let starting = false;
let stopping = false;
let timer;
let remoteBusy = false;
let closing = false;
let relaySessionOpen = false;
const remote = new RelayPublisher((state, count) => {
  $('remoteStatus').textContent = state === 'connected' ? `Server connected · ${count} remote viewer${count === 1 ? '' : 's'}` : state === 'reconnecting' ? 'Reconnecting to server…' : 'Server disconnected';
  updateViewerCount();
});
const settings = () => ({ height: Number($('quality').value), fps: Number($('frameRate').value), bitrate: Number($('bitrate').value) });

function lockCapture(locked) {
  for (const id of ['source', 'refreshSources', 'preset', 'quality', 'frameRate', 'bitrate', 'includeAudio']) $(id).disabled = locked;
  $('shareButton').disabled = locked || !$('source').value;
}

async function refreshSources() {
  if (stream || starting) return;
  $('refreshSources').disabled = true;
  try {
    const selected = $('source').value;
    const sources = await window.chdss.sources();
    $('source').replaceChildren(...sources.map(source => new Option(source.name, source.id)));
    if (sources.some(source => source.id === selected)) $('source').value = selected;
    $('sourceSummary').textContent = sources.length ? $('source').selectedOptions[0].textContent : 'No screens available';
    if (!sources.length) setError('No screens or windows are available. Check recording permissions, then refresh sources.');
    else setError();
  } catch (error) { setError(`Could not list screens or windows: ${error.message}. Grant screen-recording access, then fully quit and reopen CHDSS.`); }
  finally { lockCapture(false); }
}

function setError(message = '') {
  $('errorNotice').textContent = message;
  $('errorNotice').classList.toggle('hidden', !message);
}

function socketUrl() {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/signal`;
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function updateViewerCount() {
  $('viewerCount').textContent = String(peers.size + waitingViewers.size + remote.viewers);
}

async function createPeer(viewerId) {
  if (!stream || peers.has(viewerId)) return;
  waitingViewers.delete(viewerId);
  const peer = new RTCPeerConnection(connectionPolicy());
  peer.pendingCandidates = [];
  peers.set(viewerId, peer);
  updateViewerCount();
  peer.onicecandidate = event => event.candidate && send({ type: 'signal', viewerId, payload: { candidate: event.candidate } });
  peer.onconnectionstatechange = () => {
    if (['failed', 'closed'].includes(peer.connectionState)) removePeer(viewerId);
  };
  for (const track of stream.getTracks()) {
    const sender = peer.addTrack(track, stream);
    await tuneSender(sender, track.kind === 'video' ? { maxBitrate: Number($('bitrate').value), maxFramerate: Number($('frameRate').value) } : {});
  }
  const offer = preferOpusStereo(await peer.createOffer());
  await peer.setLocalDescription(offer);
  send({ type: 'signal', viewerId, payload: { description: peer.localDescription } });
}

function removePeer(viewerId) {
  peers.get(viewerId)?.close();
  peers.delete(viewerId);
  waitingViewers.delete(viewerId);
  updateViewerCount();
}

async function handleSignal(message) {
  const peer = peers.get(message.viewerId);
  if (!peer) return;
  if (message.payload.description) {
    await peer.setRemoteDescription(message.payload.description);
    for (const candidate of peer.pendingCandidates) await peer.addIceCandidate(candidate);
    peer.pendingCandidates = [];
  }
  if (message.payload.candidate) {
    if (peer.remoteDescription) await peer.addIceCandidate(message.payload.candidate);
    else peer.pendingCandidates.push(message.payload.candidate);
  }
}

function connect() {
  socket = new WebSocket(socketUrl());
  socket.onopen = () => send({ type: 'hello', role: 'host', token });
  socket.onmessage = async event => {
    try {
      const message = JSON.parse(event.data);
      if (message.type === 'viewer-joined') {
        if (stream) await createPeer(message.viewerId);
        else { waitingViewers.add(message.viewerId); updateViewerCount(); }
      }
      if (message.type === 'viewer-left') removePeer(message.viewerId);
      if (message.type === 'signal') await handleSignal(message);
    } catch (error) { setError(`Connection error: ${error.message}`); }
  };
  socket.onclose = event => {
    for (const id of [...peers.keys()]) removePeer(id);
    waitingViewers.clear();
    updateViewerCount();
    if (!closing && event.code !== 1008) setTimeout(connect, 1000);
    else if (!closing) setError('Local broadcaster authentication failed. Quit and reopen CHDSS.');
  };
}

function startMeter(audioTrack) {
  meterContext = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  const source = meterContext.createMediaStreamSource(new MediaStream([audioTrack]));
  const analyser = meterContext.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);
  const samples = new Uint8Array(analyser.frequencyBinCount);
  const draw = () => {
    analyser.getByteFrequencyData(samples);
    const level = samples.reduce((sum, value) => sum + value, 0) / samples.length / 255;
    $('audioMeter').firstElementChild.style.width = `${Math.min(100, level * 180)}%`;
    meterFrame = requestAnimationFrame(draw);
  };
  draw();
}

async function stopShare() {
  if (stopping) return;
  stopping = true;
  try {
  shareGeneration++;
  const audio = filteredAudio;
  filteredAudio = null;
  send({ type: 'stream-stopped' });
  stream?.getTracks().forEach(track => track.stop());
  stream = null;
  for (const id of [...peers.keys()]) { removePeer(id); waitingViewers.add(id); }
  updateViewerCount();
  cancelAnimationFrame(meterFrame);
  meterContext?.close().catch(() => {});
  meterContext = null;
  $('preview').srcObject = null;
  $('previewEmpty').classList.remove('hidden');
  $('shareButton').classList.remove('hidden');
  $('stopButton').classList.add('hidden');
  $('liveBadge').textContent = 'Offline';
  $('liveBadge').className = 'badge waiting';
  $('audioStatus').textContent = 'Not captured';
  $('audioMeter').firstElementChild.style.width = '0';
  clearInterval(timer);
  $('elapsed').textContent = '00:00';
  $('streamStats').textContent = 'Ready to broadcast';
  $('muteAudio').disabled = true;
  lockCapture(true);
  await audio?.stop();
  if (!audio) await window.chdss.stopAudio();
  await window.chdss.setSharing(false);
  try { await remote.unpublish(); } catch { setError('The Internet upload stopped unexpectedly. End the Internet session before reconnecting.'); }
  } finally { stopping = false; lockCapture(starting); }
}

async function startShare() {
  if (starting || stopping || stream || !$('source').value) return;
  starting = true;
  const generation = ++shareGeneration;
  lockCapture(true);
  setError();
  let captured;
  try {
    await window.chdss.selectSource($('source').value);
    captured = await navigator.mediaDevices.getDisplayMedia(captureOptions(settings(), false));
    captured.getVideoTracks()[0].onended = stopShare;
    if ($('includeAudio').checked) {
      const audio = new FilteredAudio(window.chdss, { onFailure: message => { void stopShare(); setError(`Sharing stopped: ${message}`); } });
      filteredAudio = audio;
      const result = await audio.start($('source').value);
      captured.addTrack(result.track);
      audioLabel = result.scope === 'application' ? 'Selected application audio' : 'Screen audio · Discord excluded';
    }
    if (generation !== shareGeneration || captured.getVideoTracks()[0].readyState === 'ended') { captured.getTracks().forEach(track => track.stop()); return; }
    const { audioTrack, videoTrack } = validateCapture(captured, $('includeAudio').checked);
    stream = captured;
    if (audioTrack) audioTrack.contentHint = 'music';
    videoTrack.contentHint = presets[$('preset').value]?.hint ?? 'motion';
    videoTrack.onended = stopShare;
    if (audioTrack) audioTrack.onended = () => { void stopShare(); setError('Sharing stopped because filtered audio ended. Restart sharing.'); };
    $('preview').srcObject = stream;
    $('previewEmpty').classList.add('hidden');
    $('shareButton').classList.add('hidden');
    $('stopButton').classList.remove('hidden');
    $('liveBadge').textContent = 'Live';
    $('liveBadge').className = 'badge live';
    $('audioStatus').textContent = audioTrack ? `${audioLabel} · live` : 'Video only · audio off';
    $('muteAudio').disabled = !audioTrack;
    $('muteAudio').textContent = 'Mute';
    $('muteAudio').setAttribute('aria-pressed', 'false');
    if (audioTrack) { try { startMeter(audioTrack); } catch { /* Meter failure must not stop capture. */ } }
    await window.chdss.setSharing(true);
    if (!stream) return;
    const startedAt = performance.now();
    timer = setInterval(() => {
      const seconds = Math.floor((performance.now() - startedAt) / 1000);
      $('elapsed').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
      const actual = videoTrack.getSettings();
      $('streamStats').textContent = `${actual.width ?? '—'} × ${actual.height ?? '—'} · ${Math.round(actual.frameRate ?? 0)} fps`;
    }, 1000);
    for (const id of [...waitingViewers]) {
      try { await createPeer(id); } catch (error) { removePeer(id); setError(`A LAN viewer could not connect: ${error.message}`); }
    }
    if (stream && remote.connected) {
      try { await remote.publish(stream, settings()); } catch (error) { setError(`LAN is live; Internet publishing failed: ${error.message}`); }
    }
  } catch (error) {
    captured?.getTracks().forEach(track => track.stop());
    starting = false;
    if (generation !== shareGeneration) return;
    await stopShare();
    if (error.name !== 'NotAllowedError') setError(error.message);
    else setError('Screen sharing was cancelled or denied. Allow screen and system-audio access, then try again.');
  } finally { starting = false; if (!stream) lockCapture(false); }
}

function applyPreset() {
  const preset = presets[$('preset').value] ?? presets.balanced;
  $('quality').value = String(preset.height);
  $('frameRate').value = String(preset.fps);
  $('bitrate').value = String(preset.bitrate);
  try { localStorage.setItem('chdss-preset', $('preset').value); } catch { /* Preferences are optional. */ }
}

async function endInternet() {
  if (remoteBusy) return;
  remoteBusy = true;
  $('remoteDisconnect').disabled = true;
  try {
    await remote.disconnect();
    await window.chdss.endRelay();
    relaySessionOpen = false;
    $('remoteInvite').classList.add('hidden');
    $('streamPassword').value = '';
    $('remoteViewerUrl').value = '';
    $('remoteDisconnect').classList.add('hidden');
    $('remoteStatus').textContent = 'Internet session ended. The password is no longer valid.';
  } catch (error) { setError(`Upload stopped, but the server has not confirmed revocation. Retry End Internet session. ${error.message}`); }
  finally {
    remoteBusy = false;
    $('remoteDisconnect').disabled = false;
    $('remoteConnect').disabled = relaySessionOpen;
  }
}

async function connectInternet() {
  if (remoteBusy || relaySessionOpen) return;
  let origin;
  try { origin = relayOrigin($('serverUrl').value); } catch (error) { setError(error.message); return; }
  remoteBusy = true;
  $('remoteConnect').disabled = true;
  $('remoteStatus').textContent = 'Creating private session…';
  try {
    relaySessionOpen = true;
    $('remoteDisconnect').classList.remove('hidden');
    const session = await window.chdss.createRelay(origin, $('publisherKey').value);
    $('publisherKey').value = '';
    await remote.connect(session);
    $('remoteViewerUrl').value = session.viewerUrl;
    $('streamPassword').value = session.password;
    $('streamPassword').type = 'password';
    $('remoteInvite').classList.remove('hidden');
    if (stream) await remote.publish(stream, settings());
  } catch (error) {
    await remote.disconnect().catch(() => {});
    setError(`Internet connection failed. LAN is unaffected. ${error.message}`);
    $('remoteStatus').textContent = 'Connection failed. End this session before retrying.';
  } finally { remoteBusy = false; $('remoteConnect').disabled = relaySessionOpen; }
}

async function initialize() {
  if (!window.chdss) throw new Error('The desktop bridge did not load. Open CHDSS.app / the portable executable, not host.html in a browser.');
  const details = await window.chdss.details();
  token = details.hostToken;
  document.body.classList.add(`platform-${details.platform}`);
  $('viewerUrl').value = details.viewerUrls[0];
  $('permissionNotice').classList.toggle('hidden', details.screenPermission === 'granted');
  try { const saved = localStorage.getItem('chdss-preset'); if (presets[saved]) $('preset').value = saved; } catch { /* Optional preference. */ }
  applyPreset();
  $('preset').onchange = applyPreset;
  $('source').onchange = () => { $('sourceSummary').textContent = $('source').selectedOptions[0]?.textContent ?? 'Select a source'; $('shareButton').disabled = !$('source').value; };
  $('refreshSources').onclick = refreshSources;
  $('permissions').onclick = () => window.chdss.openPermissions();
  $('shareButton').onclick = startShare;
  $('stopButton').onclick = stopShare;
  $('copyUrl').onclick = async () => { await window.chdss.copy($('viewerUrl').value); $('copyUrl').textContent = 'Copied'; setTimeout(() => { $('copyUrl').textContent = 'Copy'; }, 1200); };
  $('muteAudio').onclick = () => {
    const track = stream?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    remote.setAudioEnabled(track.enabled);
    $('muteAudio').textContent = track.enabled ? 'Mute' : 'Unmute';
    $('muteAudio').setAttribute('aria-pressed', String(!track.enabled));
    $('audioStatus').textContent = `${audioLabel} · ${track.enabled ? 'live' : 'muted'}`;
  };
  for (const [id, internet] of [['modeLan', false], ['modeInternet', true]]) $(id).onclick = () => {
    $('modeLan').setAttribute('aria-pressed', String(!internet));
    $('modeInternet').setAttribute('aria-pressed', String(internet));
    $('lanPanel').classList.toggle('hidden', internet);
    $('internetPanel').classList.toggle('hidden', !internet);
  };
  $('remoteConnect').onclick = connectInternet;
  $('remoteDisconnect').onclick = endInternet;
  $('revealPassword').onclick = () => { const visible = $('streamPassword').type === 'password'; $('streamPassword').type = visible ? 'text' : 'password'; $('revealPassword').textContent = visible ? 'Hide' : 'Show'; $('revealPassword').setAttribute('aria-pressed', String(visible)); };
  $('copyInvite').onclick = async () => { await window.chdss.copy(`Watch my CHDSS stream: ${$('remoteViewerUrl').value}\nPassword: ${$('streamPassword').value}`); $('copyInvite').textContent = 'Invitation copied'; setTimeout(() => { $('copyInvite').textContent = 'Copy invitation'; }, 1200); };
  window.chdss.onCommand(command => {
    if (command === 'refresh-sources') void refreshSources();
    if (command === 'toggle-sharing') void (stream ? stopShare() : startShare());
  });
  connect();
  await refreshSources();
}

window.addEventListener('beforeunload', () => { closing = true; socket?.close(); stream?.getTracks().forEach(track => track.stop()); void remote.disconnect(); });
initialize().catch(error => setError(error.message));
