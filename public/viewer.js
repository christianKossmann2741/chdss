import { connectionPolicy } from './webrtc.js';

const token = decodeURIComponent(location.hash.slice(1));
const video = document.getElementById('stream');
const badge = document.getElementById('connectionBadge');
const empty = document.getElementById('emptyState');
const pip = document.getElementById('pipButton');
const fullscreen = document.getElementById('fullscreenButton');
const play = document.getElementById('playButton');
const stats = document.getElementById('stats');
let socket;
let peer;
let statsTimer;
let pendingCandidates = [];

function setBadge(text, state = 'waiting') {
  badge.textContent = text;
  badge.className = `badge ${state}`;
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function resetPeer() {
  clearInterval(statsTimer);
  peer?.close();
  peer = null;
  pendingCandidates = [];
  video.srcObject = null;
  video.classList.remove('receiving');
  empty.classList.remove('hidden');
  pip.disabled = true;
  fullscreen.disabled = true;
  stats.textContent = 'No media received';
}

function startStats() {
  let previousBytes = 0;
  let previousAt = performance.now();
  statsTimer = setInterval(async () => {
    if (!peer) return;
    const reports = await peer.getStats();
    let inbound;
    reports.forEach(report => { if (report.type === 'inbound-rtp' && report.kind === 'video') inbound = report; });
    if (!inbound) return;
    const now = performance.now();
    const bitrate = previousBytes ? Math.round((inbound.bytesReceived - previousBytes) * 8 / (now - previousAt)) : 0;
    previousBytes = inbound.bytesReceived;
    previousAt = now;
    const track = video.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : 'Receiving';
    stats.textContent = `${track} · ${bitrate ? `${(bitrate / 1000).toFixed(1)} Mbps` : 'warming up'}`;
  }, 1000);
}

function makePeer() {
  resetPeer();
  peer = new RTCPeerConnection(connectionPolicy());
  peer.onicecandidate = event => event.candidate && send({ type: 'signal', payload: { candidate: event.candidate } });
  peer.ontrack = event => {
    video.srcObject = event.streams[0] ?? new MediaStream([event.track]);
    video.classList.add('receiving');
    empty.classList.add('hidden');
    pip.disabled = !document.pictureInPictureEnabled;
    fullscreen.disabled = false;
    video.play().catch(() => setBadge('Click “Play with audio”', 'waiting'));
  };
  peer.onconnectionstatechange = () => {
    if (peer.connectionState === 'connected') { setBadge('Live', 'live'); startStats(); }
    if (['failed', 'disconnected'].includes(peer.connectionState)) setBadge('Feed interrupted', 'error');
  };
}

async function handleSignal(payload) {
  if (!peer) makePeer();
  if (payload.description) {
    await peer.setRemoteDescription(payload.description);
    for (const candidate of pendingCandidates) await peer.addIceCandidate(candidate);
    pendingCandidates = [];
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    send({ type: 'signal', payload: { description: peer.localDescription } });
  }
  if (payload.candidate) {
    if (peer.remoteDescription) await peer.addIceCandidate(payload.candidate);
    else pendingCandidates.push(payload.candidate);
  }
}

function connect() {
  if (!token) { setBadge('Pairing code missing', 'error'); return; }
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${protocol}://${location.host}/signal`);
  socket.onopen = () => send({ type: 'hello', role: 'viewer', token });
  socket.onmessage = async event => {
    const message = JSON.parse(event.data);
    try {
      if (message.type === 'ready') setBadge('Waiting for broadcast');
      if (message.type === 'signal') await handleSignal(message.payload);
      if (message.type === 'host-left') { resetPeer(); setBadge('Host stopped', 'waiting'); }
      if (message.type === 'error') setBadge(message.message, 'error');
    } catch (error) { setBadge(`Media error: ${error.message}`, 'error'); }
  };
  socket.onclose = event => {
    resetPeer();
    if (event.code === 1008) { setBadge('Invalid pairing code', 'error'); return; }
    setBadge('Reconnecting…');
    setTimeout(connect, 1000);
  };
  socket.onerror = () => setBadge('Cannot reach host', 'error');
}

play.onclick = () => video.play();
pip.onclick = async () => {
  if (document.pictureInPictureElement) await document.exitPictureInPicture();
  else if (document.pictureInPictureEnabled) await video.requestPictureInPicture();
};
fullscreen.onclick = () => video.requestFullscreen();
video.addEventListener('volumechange', () => { play.textContent = video.muted ? 'Unmute audio' : 'Audio playing'; });
connect();
