import { audioConstraints, connectionPolicy, preferOpusStereo, tuneSender } from './webrtc.js';

const token = decodeURIComponent(location.hash.slice(1));
const peers = new Map();
const waitingViewers = new Set();
let socket;
let stream;
let meterContext;
let meterFrame;
const $ = id => document.getElementById(id);
const qualityHeights = { '720': 720, '1080': 1080, '1440': 1440 };

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
  $('viewerCount').textContent = String(peers.size + waitingViewers.size);
}

async function createPeer(viewerId) {
  if (!stream || peers.has(viewerId)) return;
  waitingViewers.delete(viewerId);
  const peer = new RTCPeerConnection(connectionPolicy());
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
  if (message.payload.description) await peer.setRemoteDescription(message.payload.description);
  if (message.payload.candidate) await peer.addIceCandidate(message.payload.candidate);
}

function connect() {
  socket = new WebSocket(socketUrl());
  socket.onopen = () => send({ type: 'hello', role: 'host', token });
  socket.onmessage = async event => {
    const message = JSON.parse(event.data);
    try {
      if (message.type === 'viewer-joined') {
        if (stream) await createPeer(message.viewerId);
        else { waitingViewers.add(message.viewerId); updateViewerCount(); }
      }
      if (message.type === 'viewer-left') removePeer(message.viewerId);
      if (message.type === 'signal') await handleSignal(message);
    } catch (error) { setError(`Connection error: ${error.message}`); }
  };
  socket.onclose = () => {
    for (const id of [...peers.keys()]) removePeer(id);
    setTimeout(connect, 1000);
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

function stopShare() {
  stream?.getTracks().forEach(track => track.stop());
  stream = null;
  for (const id of [...peers.keys()]) removePeer(id);
  cancelAnimationFrame(meterFrame);
  meterContext?.close();
  meterContext = null;
  $('preview').srcObject = null;
  $('previewEmpty').classList.remove('hidden');
  $('shareButton').classList.remove('hidden');
  $('stopButton').classList.add('hidden');
  $('liveBadge').textContent = 'Offline';
  $('liveBadge').className = 'badge waiting';
  $('audioStatus').textContent = 'Not captured';
  $('audioMeter').firstElementChild.style.width = '0';
}

async function startShare() {
  setError();
  const frameRate = Number($('frameRate').value);
  const height = qualityHeights[$('quality').value];
  const video = { frameRate: { ideal: frameRate, max: frameRate } };
  if (height) video.height = { ideal: height };
  try {
    await window.chdss.selectSource($('source').value);
    const captured = await navigator.mediaDevices.getDisplayMedia({ video, audio: audioConstraints() });
    const audioTrack = captured.getAudioTracks()[0];
    const videoTrack = captured.getVideoTracks()[0];
    if (!videoTrack) throw new Error('No video track was selected.');
    if (!audioTrack) {
      captured.getTracks().forEach(track => track.stop());
      throw new Error('No audio track was captured. Choose a source with “Share audio” enabled. On macOS, grant System Audio Recording permission if prompted.');
    }
    stream = captured;
    audioTrack.contentHint = 'music';
    videoTrack.contentHint = 'motion';
    videoTrack.onended = stopShare;
    audioTrack.onended = () => setError('The shared audio track ended. Stop and restart sharing to restore sound.');
    $('preview').srcObject = stream;
    $('previewEmpty').classList.add('hidden');
    $('shareButton').classList.add('hidden');
    $('stopButton').classList.remove('hidden');
    $('liveBadge').textContent = 'Live';
    $('liveBadge').className = 'badge live';
    $('audioStatus').textContent = `${audioTrack.label || 'System audio'} · ${audioTrack.readyState}`;
    startMeter(audioTrack);
    for (const id of [...waitingViewers]) await createPeer(id);
  } catch (error) {
    if (error.name !== 'NotAllowedError') setError(error.message);
    else setError('Screen sharing was cancelled or denied. Allow screen and system-audio access, then try again.');
  }
}

const details = await window.chdss.details();
$('viewerUrl').value = details.viewerUrls[0];
$('permissionNotice').classList.toggle('hidden', details.screenPermission !== 'denied');
for (const source of await window.chdss.sources()) {
  const option = document.createElement('option');
  option.value = source.id;
  option.textContent = source.name;
  $('source').append(option);
}
$('shareButton').disabled = !$('source').value;
$('copyUrl').onclick = async () => { await window.chdss.copy($('viewerUrl').value); $('copyUrl').textContent = 'Copied'; setTimeout(() => { $('copyUrl').textContent = 'Copy'; }, 1200); };
$('permissions').onclick = () => window.chdss.openPermissions();
$('shareButton').onclick = startShare;
$('stopButton').onclick = stopShare;
window.addEventListener('beforeunload', stopShare);
connect();
