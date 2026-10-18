import { connectionPolicy, preferOpusStereo, tuneSender } from './webrtc.js';
import { captureOptions, presets, relayOrigin, validateCapture } from './broadcast.js';
import { RelayPublisher } from './remote.js';
import { FilteredAudio } from './filtered-audio.js';
import { FlapBoard, Sparkline, Ticker, Waveform, barcode, boot, clock, formatBitrate, groupDigits, scramble, screenFilter, timecode, typewriter } from './hud.js';

let token;
let details;
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
let startedAt = 0;
let remoteBusy = false;
let closing = false;
let relaySessionOpen = false;
let relayHost = '';
let uplinkRate = 0;
let previousBytes = new Map();
let previousSample = 0;
const viewerFlaps = new FlapBoard($('viewerFlaps'), { length: 2 });
const meter = new Waveform($('audioMeter'), { bars: 56 });
const miniMeter = new Waveform($('miniWave'), { bars: 40 });
const uplinkChart = new Sparkline($('uplinkChart'), { capacity: 60 });
const ticker = new Ticker($('ticker'));
const remote = new RelayPublisher((state, count) => {
  $('remoteStatus').textContent = state === 'connected' ? `Server connected · ${count} remote viewer${count === 1 ? '' : 's'}` : state === 'reconnecting' ? 'Reconnecting to server…' : 'Server disconnected';
  updateViewerCount();
});
const settings = () => ({ height: Number($('quality').value), fps: Number($('frameRate').value), bitrate: Number($('bitrate').value) });

function lockCapture(locked) {
  for (const id of ['source', 'refreshSources', 'preset', 'quality', 'frameRate', 'bitrate', 'includeAudio']) $(id).disabled = locked;
  $('shareButton').disabled = locked || !$('source').value;
  if (!locked && !stream) setRoute();
}

/** Status line + route rail. Each step is '', 'active', 'done' or 'skipped'. */
function setRoute(steps = {}, message) {
  const hasSource = Boolean($('source').value);
  const state = { source: hasSource ? 'done' : 'active', capture: '', audio: '', air: '', ...steps };
  for (const item of $('route').children) item.className = state[item.dataset.step] ?? '';
  if (message === undefined) message = hasSource ? `Ready · ${$('source').selectedOptions[0]?.textContent ?? 'source'} · press start` : 'Select a source';
  typewriter($('typeline'), message);
}

function setTitle(text) {
  if ($('stateTitle').textContent !== text) scramble($('stateTitle'), text, { duration: 380 });
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

function viewerTotal() { return peers.size + waitingViewers.size + remote.viewers; }

function updateViewerCount() {
  const total = viewerTotal();
  $('viewerCount').textContent = String(total);
  viewerFlaps.set(total);
  $('uplinkN').textContent = `N = ${peers.size + remote.viewers}`;
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
  analyser.fftSize = 512;
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  let last = 0;
  const draw = now => {
    meterFrame = requestAnimationFrame(draw);
    if (now - last < 50) return;
    last = now;
    analyser.getFloatTimeDomainData(samples);
    let peak = 0;
    for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
    // Perceptual curve so quiet program audio is still visibly alive.
    const level = audioTrack.enabled ? Math.min(1, Math.sqrt(peak) * 1.15) : 0;
    meter.push(level);
    miniMeter.push(level);
  };
  meterFrame = requestAnimationFrame(draw);
}

/** Measures actual bytes leaving this machine across LAN peers and the relay upload. */
async function sampleUplink() {
  const counters = new Map();
  await Promise.all([...peers].map(async ([viewerId, peer]) => {
    try { (await peer.getStats()).forEach(report => { if (report.type === 'outbound-rtp') counters.set(`${viewerId}:${report.id}`, report.bytesSent ?? 0); }); } catch { /* Stats are optional. */ }
  }));
  try { for (const [id, bytes] of await remote.bytesSent()) counters.set(`relay:${id}`, bytes); } catch { /* Stats are optional. */ }
  const now = performance.now();
  let delta = 0;
  for (const [id, bytes] of counters) { const before = previousBytes.get(id); if (before !== undefined && bytes >= before) delta += bytes - before; }
  uplinkRate = previousSample ? delta * 8 / ((now - previousSample) / 1000) : 0;
  previousBytes = counters;
  previousSample = now;
}

let beating = false;
async function heartbeat() {
  if (beating) return;
  beating = true;
  try { await pulse(); } finally { beating = false; }
}

async function pulse() {
  const live = Boolean(stream);
  if (live) {
    const videoTrack = stream.getVideoTracks()[0];
    const actual = videoTrack?.getSettings() ?? {};
    const seconds = (performance.now() - startedAt) / 1000;
    $('elapsed').textContent = timecode(seconds);
    $('timecodeLabel').textContent = 'On air';
    $('streamStats').textContent = `${actual.width ?? '—'} × ${actual.height ?? '—'} · ${Math.round(actual.frameRate ?? 0)} fps`;
    const fidelity = actual.frameRate ? Math.min(0.99, actual.frameRate / Number($('frameRate').value)) : 0;
    $('lockTag').textContent = `Lock ${fidelity.toFixed(2)}`;
    await sampleUplink();
    uplinkChart.push(uplinkRate);
  } else {
    $('elapsed').textContent = clock();
    $('timecodeLabel').textContent = 'Local';
    uplinkRate = 0;
  }
  $('uplinkValue').textContent = groupDigits(uplinkRate / 1000);
  const lan = $('networkAdapter').selectedOptions[0]?.textContent?.split(' · ')[0] ?? '—';
  const actual = live ? stream.getVideoTracks()[0]?.getSettings() ?? {} : {};
  const { height, fps } = settings();
  ticker.set([
    ['Status', live ? 'On air' : starting ? 'Arming' : 'Standby', live ? 'hot' : ''],
    ['Viewers', `${viewerTotal()} · LAN ${peers.size + waitingViewers.size} · NET ${remote.viewers}`],
    ['Source', $('source').selectedOptions[0]?.textContent ?? '—'],
    ['Capture', live ? `${actual.width ?? '—'}×${actual.height ?? '—'} @ ${Math.round(actual.frameRate ?? 0)} fps` : `${Number.isFinite(height) ? `${height}p` : 'native'} @ ${fps} fps`],
    ['Uplink', live ? formatBitrate(uplinkRate) : 'idle', live && uplinkRate ? 'hot' : ''],
    ['Cap', formatBitrate(Number($('bitrate').value))],
    ['Audio', live ? $('audioStatus').textContent : $('includeAudio').checked ? 'Filtered · armed' : 'Video only'],
    ['Codec', 'Opus 48k stereo · FEC'],
    ['LAN', lan],
    ['Relay', relaySessionOpen ? relayHost : 'Offline', relaySessionOpen ? 'hot' : ''],
    ['Pairing', '192-bit · rotates each launch'],
    ['Trackers', '0'],
    ['Build', `CHDSS ${details?.version ?? ''}`]
  ]);
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
  meter.clear();
  miniMeter.clear();
  uplinkChart.clear();
  previousBytes = new Map();
  previousSample = 0;
  document.body.classList.remove('on-air');
  $('preview').srcObject = null;
  $('previewFrame').classList.remove('has-video');
  $('previewEmpty').classList.remove('hidden');
  $('shareButton').classList.remove('hidden');
  $('stopButton').classList.add('hidden');
  $('liveBadge').textContent = 'Offline';
  $('liveBadge').className = 'badge waiting';
  $('audioStatus').textContent = 'Not captured';
  $('lockTag').textContent = 'Lock 0.00';
  $('streamStats').textContent = 'Ready to broadcast';
  $('muteAudio').disabled = true;
  $('audioPanel').classList.remove('muted');
  $('audioBuffer').textContent = '48k · stereo';
  setTitle('Standby');
  lockCapture(true);
  await audio?.stop();
  if (!audio) await window.chdss.stopAudio();
  await window.chdss.setSharing(false);
  try { await remote.unpublish(); } catch { setError('The Internet upload stopped unexpectedly. End the Internet session before reconnecting.'); }
  } finally { stopping = false; lockCapture(starting); void heartbeat(); }
}

async function startShare() {
  if (starting || stopping || stream || !$('source').value) return;
  starting = true;
  const generation = ++shareGeneration;
  lockCapture(true);
  setError();
  setTitle('Arming');
  setRoute({ source: 'done', capture: 'active' }, 'Acquiring capture…');
  let captured;
  try {
    await window.chdss.selectSource($('source').value);
    captured = await navigator.mediaDevices.getDisplayMedia(captureOptions(settings(), false));
    captured.getVideoTracks()[0].onended = stopShare;
    if ($('includeAudio').checked) {
      setRoute({ source: 'done', capture: 'done', audio: 'active' }, 'Opening filtered audio…');
      const audio = new FilteredAudio(window.chdss, {
        onFailure: message => { void stopShare(); setError(`Sharing stopped: ${message}`); },
        onBuffer: ({ ms }) => { $('audioBuffer').textContent = `Buffer ≈ ${ms} ms`; }
      });
      filteredAudio = audio;
      const result = await audio.start($('source').value);
      captured.addTrack(result.track);
      audioLabel = result.scope === 'application' ? 'Selected application' : 'Screen · Discord excluded';
    }
    if (generation !== shareGeneration || captured.getVideoTracks()[0].readyState === 'ended') { captured.getTracks().forEach(track => track.stop()); return; }
    const { audioTrack, videoTrack } = validateCapture(captured, $('includeAudio').checked);
    stream = captured;
    if (audioTrack) audioTrack.contentHint = 'music';
    videoTrack.contentHint = presets[$('preset').value]?.hint ?? 'motion';
    videoTrack.onended = stopShare;
    if (audioTrack) audioTrack.onended = () => { void stopShare(); setError('Sharing stopped because filtered audio ended. Restart sharing.'); };
    $('preview').srcObject = stream;
    $('previewFrame').classList.add('has-video');
    $('previewEmpty').classList.add('hidden');
    $('shareButton').classList.add('hidden');
    $('stopButton').classList.remove('hidden');
    $('liveBadge').textContent = 'Live';
    $('liveBadge').className = 'badge live';
    document.body.classList.add('on-air');
    setTitle('On air');
    setRoute({ source: 'done', capture: 'done', audio: audioTrack ? 'done' : 'skipped', air: 'done' }, 'On air · share the viewer link');
    $('audioStatus').textContent = audioTrack ? `${audioLabel} · live` : 'Video only · audio off';
    $('muteAudio').disabled = !audioTrack;
    $('muteAudio').textContent = 'Mute';
    $('muteAudio').setAttribute('aria-pressed', 'false');
    if (audioTrack) { try { startMeter(audioTrack); } catch { /* Meter failure must not stop capture. */ } }
    await window.chdss.setSharing(true);
    if (!stream) return;
    startedAt = performance.now();
    void heartbeat();
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
    setRoute({}, 'Fault · see alert');
  } finally { starting = false; if (!stream) lockCapture(false); }
}

function syncSpec() {
  const preset = $('preset').selectedOptions[0]?.textContent ?? 'Custom';
  const custom = presets[$('preset').value] && (settings().fps !== presets[$('preset').value].fps || Number($('bitrate').value) !== presets[$('preset').value].bitrate || $('quality').value !== String(presets[$('preset').value].height));
  scramble($('specTitle'), custom ? `${preset} · custom` : preset, { duration: 320 });
  $('capLabel').textContent = `Cap · ${formatBitrate(Number($('bitrate').value))}`;
  uplinkChart.ceiling = Number($('bitrate').value);
  uplinkChart.draw();
  if (!stream && !starting) setRoute();
}

function applyPreset() {
  const preset = presets[$('preset').value] ?? presets.balanced;
  $('quality').value = String(preset.height);
  $('frameRate').value = String(preset.fps);
  $('bitrate').value = String(preset.bitrate);
  try { localStorage.setItem('chdss-preset', $('preset').value); } catch { /* Preferences are optional. */ }
  syncSpec();
}

function selectNetworkAddress() {
  $('viewerUrl').value = $('networkAdapter').selectedOptions[0]?.dataset.url ?? '';
  $('copyUrl').disabled = !$('viewerUrl').value;
  try { localStorage.setItem('chdss-network', $('networkAdapter').value); } catch { /* No invitation token is persisted. */ }
}

function refreshViewerLinks(details) {
  let selected = $('networkAdapter').value;
  if (!selected) { try { selected = localStorage.getItem('chdss-network'); } catch { /* Optional preference. */ } }
  const addresses = details.networkAddresses ?? details.viewerUrls.map(url => ({ adapter: 'Network', address: new URL(url).hostname, url }));
  $('networkAdapter').replaceChildren(...addresses.map(entry => {
    const option = new Option(`${entry.address} · ${entry.adapter}`, JSON.stringify([entry.adapter, entry.address]));
    option.dataset.url = entry.url;
    return option;
  }));
  if ([...$('networkAdapter').options].some(option => option.value === selected)) $('networkAdapter').value = selected;
  selectNetworkAddress();
}

async function refreshNetworks() {
  $('refreshNetworks').disabled = true;
  try { refreshViewerLinks(await window.chdss.details()); }
  catch { setError('Could not refresh network addresses. The existing invitation has not changed. Try again.'); }
  finally { $('refreshNetworks').disabled = false; }
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
    relayHost = new URL(origin).host;
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

function flash(button, text, reset) {
  button.textContent = text;
  setTimeout(() => { button.textContent = reset; }, 1200);
}

async function initialize() {
  if (!window.chdss) throw new Error('The desktop bridge did not load. Open CHDSS.app / the portable executable, not host.html in a browser.');
  boot();
  const filter = screenFilter($('fxToggle'));
  $('fxToggle').onclick = () => filter.toggle();
  details = await window.chdss.details();
  token = details.hostToken;
  document.body.classList.add(`platform-${details.platform}`);
  $('versionLabel').textContent = `CHDSS ${details.version ?? ''} · private · no trackers`;
  $('shareShortcut').textContent = details.platform === 'darwin' ? '⌘⇧S' : 'Ctrl⇧S';
  // A decorative per-launch label; deliberately unrelated to any pairing secret.
  const label = `CH-${String(details.version ?? '3').split('.')[0]}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  $('specCode').textContent = label;
  barcode($('specBarcode'), label);
  viewerFlaps.set(0);
  refreshViewerLinks(details);
  $('networkAdapter').onchange = selectNetworkAddress;
  $('refreshNetworks').onclick = refreshNetworks;
  $('permissionNotice').classList.toggle('hidden', details.screenPermission === 'granted');
  try { const saved = localStorage.getItem('chdss-preset'); if (presets[saved]) $('preset').value = saved; } catch { /* Optional preference. */ }
  applyPreset();
  $('preset').onchange = applyPreset;
  for (const id of ['quality', 'frameRate', 'bitrate']) $(id).onchange = syncSpec;
  $('source').onchange = () => { $('sourceSummary').textContent = $('source').selectedOptions[0]?.textContent ?? 'Select a source'; $('shareButton').disabled = !$('source').value; setRoute(); };
  $('refreshSources').onclick = refreshSources;
  $('permissions').onclick = () => window.chdss.openPermissions();
  $('shareButton').onclick = startShare;
  $('stopButton').onclick = stopShare;
  $('copyUrl').onclick = async () => { await window.chdss.copy($('viewerUrl').value); flash($('copyUrl'), 'Copied', 'Copy'); };
  $('muteAudio').onclick = () => {
    const track = stream?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    remote.setAudioEnabled(track.enabled);
    $('muteAudio').textContent = track.enabled ? 'Mute' : 'Unmute';
    $('muteAudio').setAttribute('aria-pressed', String(!track.enabled));
    $('audioPanel').classList.toggle('muted', !track.enabled);
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
  $('copyInvite').onclick = async () => { await window.chdss.copy(`Watch my CHDSS stream: ${$('remoteViewerUrl').value}\nPassword: ${$('streamPassword').value}`); flash($('copyInvite'), 'Invitation copied', 'Copy invite & password'); };
  window.chdss.onCommand(command => {
    if (command === 'refresh-sources') void refreshSources();
    if (command === 'toggle-sharing') void (stream ? stopShare() : startShare());
  });
  addEventListener('resize', () => uplinkChart.draw());
  setInterval(() => { void heartbeat(); }, 1000);
  void heartbeat();
  connect();
  await refreshSources();
}

window.addEventListener('beforeunload', () => { closing = true; socket?.close(); stream?.getTracks().forEach(track => track.stop()); void remote.disconnect(); });
initialize().catch(error => setError(error.message));
