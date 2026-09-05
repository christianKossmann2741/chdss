import test from 'node:test';
import assert from 'node:assert/strict';

class Element {
  constructor() { this.value = ''; this.disabled = false; this.textContent = ''; this.className = ''; this.listeners = {}; this.attributes = {}; this.paused = true; this.volume = 1; this.muted = false; this.videoWidth = 1920; this.videoHeight = 1080; this.classList = { values: new Set(), add: x => this.classList.values.add(x), remove: x => this.classList.values.delete(x), contains: x => this.classList.values.has(x), toggle: (x, yes) => yes ? this.classList.values.add(x) : this.classList.values.delete(x) }; }
  addEventListener(name, cb) { this.listeners[name] = cb; }
  removeEventListener(name) { delete this.listeners[name]; }
  setAttribute(k,v) { this.attributes[k] = v; }
  focus() { this.focused = true; }
  async play() { this.paused = false; this.listeners.play?.(); }
  pause() { this.paused = true; this.listeners.pause?.(); }
  closest() { return null; }
}
class Stream { constructor() { this.tracks = []; } addTrack(t) { this.tracks.push(t); } removeTrack(t) { this.tracks = this.tracks.filter(x => x !== t); } getTracks() { return this.tracks; } getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); } }
function fixture(mode = 'lan') {
  const elements = new Map(); const sockets = []; const peers = []; const requests = []; const timers = new Map(); let timerId = 0;
  const document = new Element(); document.getElementById = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); }; document.pictureInPictureEnabled = true;
  class Socket { static OPEN = 1; constructor(url) { this.url = url; this.readyState = 1; this.sent = []; sockets.push(this); } send(v) { this.sent.push(JSON.parse(v)); } close() {} }
  class Peer { constructor() { peers.push(this); this.connectionState = 'new'; } close() { this.connectionState = 'closed'; } async setRemoteDescription(v) { this.remoteDescription = v; } async createAnswer() { return { type: 'answer', sdp: 'answer' }; } async setLocalDescription(v) { this.localDescription = v; } async addIceCandidate(v) { this.candidate = v; } async getStats() { return new Map(); } }
  const env = { document, location: { hash: '#pair-code', protocol: 'http:', host: 'localhost:4567' }, WebSocket: Socket, RTCPeerConnection: Peer, MediaStream: Stream, fetch: async (url, options) => { requests.push({url,options}); return mode === 'lan' ? { status: 404, ok: false } : { status: 200, ok: true, json: async () => ({ mode: 'relay' }) }; }, setInterval: cb => { timers.set(++timerId, cb); return timerId; }, clearInterval: id => timers.delete(id), setTimeout: cb => { timers.set(++timerId, cb); return timerId; }, clearTimeout: id => timers.delete(id), addEventListener() {}, removeEventListener() {} };
  return { env, elements, sockets, peers, requests, timers, $: document.getElementById };
}
async function runtime(f, options) { const module = await import('../public/viewer.js'); assert.equal(typeof module.createViewer, 'function', 'testable browser runtime'); return module.createViewer(f.env, options); }
const track = kind => ({ kind, id: `${kind}-1`, readyState: 'live', muted: false, addEventListener() {} });
test('LAN discovers 404 mode, authenticates via hash, merges independent tracks, and waits through stop/re-share', async () => {
  const f = fixture(); const app = await runtime(f); await app.start();
  assert.equal(f.sockets.length, 1); f.sockets[0].onopen(); assert.deepEqual(f.sockets[0].sent[0], { type: 'hello', role: 'viewer', token: 'pair-code' });
  await f.sockets[0].onmessage({data: JSON.stringify({type:'signal',payload:{description:{type:'offer',sdp:'offer'}}})});
  const peer = f.peers[0]; peer.ontrack({track: track('audio'), streams: []}); peer.ontrack({track: track('video'), streams: []});
  assert.equal(f.$('stream').srcObject.getTracks().length, 2);
  assert.notEqual(f.$('connectionBadge').textContent, 'Live');
  peer.connectionState = 'connected'; peer.onconnectionstatechange(); await f.$('stream').listeners.playing?.();
  assert.equal(f.$('connectionBadge').textContent, 'Live');
  await f.sockets[0].onmessage({data: JSON.stringify({type:'stream-stopped'})});
  assert.equal(f.$('stream').srcObject, null); assert.equal(f.$('fullscreenButton').disabled, true);
  await f.sockets[0].onmessage({data: JSON.stringify({type:'signal',payload:{description:{type:'offer',sdp:'second'}}})}); assert.equal(f.peers.length, 2); app.dispose();
});

test('relay only joins after password submit, lazily loads SDK, combines tracks and clears credentials on leave', async () => {
  const f = fixture('relay'); let loads = 0; const rooms = [];
  class Room { constructor() { this.events = {}; this.remoteParticipants = new Map(); rooms.push(this); } on(name, cb) { this.events[name] = cb; return this; } async connect(url, token) { this.url = url; this.token = token; } async disconnect() { this.disconnected = true; this.events.disconnected?.(); } }
  const app = await runtime(f, { loadSDK: async () => { loads++; return { Room, RoomEvent: { TrackSubscribed:'trackSubscribed', TrackUnsubscribed:'trackUnsubscribed', Reconnecting:'reconnecting', Reconnected:'reconnected', Disconnected:'disconnected' } }; } });
  await app.start(); assert.equal(f.sockets.length, 0); assert.equal(loads, 0);
  assert.equal(f.$('unlockPanel').classList.contains('hidden'), false);
  f.env.fetch = async (url, options) => { f.requests.push({url, options}); return { ok:true, json: async () => ({url:'wss://media.example.com',token:'temporary-secret',room:'private-room'}) }; };
  f.$('joinPassword').value = 'session-secret';
  await f.$('joinForm').listeners.submit({preventDefault(){}});
  assert.equal(loads, 1); assert.equal(rooms[0].url, 'wss://media.example.com');
  assert.equal(f.requests[1].url, '/api/join'); assert.deepEqual(JSON.parse(f.requests[1].options.body), {password:'session-secret'});
  assert.equal(f.$('joinPassword').value, ''); assert.notEqual(f.$('connectionBadge').textContent, 'Live');
  rooms[0].events.trackSubscribed({mediaStreamTrack:track('video')}); rooms[0].events.trackSubscribed({mediaStreamTrack:track('audio')});
  assert.equal(f.$('stream').srcObject.getTracks().length, 2);
  rooms[0].events.reconnecting(); assert.equal(f.$('connectionBadge').textContent,'Reconnecting');
  await f.$('logoutButton').listeners.click(); assert.equal(rooms[0].disconnected,true); assert.equal(f.$('stream').srcObject,null); assert.equal(f.$('joinPassword').value,''); app.dispose();
});

test('server discovery failure never silently falls back to LAN', async () => {
  const f = fixture(); f.env.fetch = async () => { throw new Error('offline'); }; const app = await runtime(f); await app.start();
  assert.equal(f.sockets.length,0); assert.equal(f.$('connectionBadge').textContent,'Server unavailable'); app.dispose();
});

test('relay video unsubscription can resume live media without reconnecting the room', async () => {
  const f = fixture('relay'); let room;
  class Room { constructor(options) { this.options = options; this.events = {}; this.remoteParticipants = new Map(); room = this; } on(n, cb) { this.events[n] = cb; } async connect() {} async disconnect() {} }
  const app = await runtime(f, {loadSDK:async()=>({Room,RoomEvent:{TrackSubscribed:'track',TrackUnsubscribed:'untrack',Reconnecting:'retry',Reconnected:'back',Disconnected:'end'}})});
  await app.start(); f.env.fetch = async () => ({ok:true,json:async()=>({url:'wss://media.example.com',token:'token'})});
  f.$('joinPassword').value = 'secret'; await f.$('joinForm').listeners.submit({preventDefault(){}});
  const first = track('video'); room.events.track({mediaStreamTrack:first}); f.$('stream').listeners.playing(); assert.equal(f.$('connectionBadge').textContent,'Live');
  room.events.untrack({mediaStreamTrack:first}); assert.equal(f.$('stream').srcObject,null);
  room.events.track({mediaStreamTrack:{...track('video'),id:'video-2'}}); f.$('stream').listeners.playing(); assert.equal(f.$('connectionBadge').textContent,'Live');
  assert.equal(room.options.adaptiveStream,false,'unattached tracks cannot use element visibility adaptation'); app.dispose();
});

test('wrong relay password clears input and never loads media SDK', async () => {
  const f = fixture('relay'); let loaded = false; const app = await runtime(f,{loadSDK:async()=>{loaded=true;}}); await app.start();
  f.env.fetch = async()=>({ok:false,status:401}); f.$('joinPassword').value='wrong'; await f.$('joinForm').listeners.submit({preventDefault(){}});
  assert.equal(loaded,false); assert.equal(f.$('joinPassword').value,''); assert.match(f.$('joinError').textContent,/password was not accepted/); assert.equal(f.$('joinButton').disabled,false); app.dispose();
});

test('malformed LAN hash and invalid authentication never start retry loops', async () => {
  const f = fixture(); f.env.location.hash='#%ZZ'; const app=await runtime(f); await app.start(); assert.equal(f.sockets.length,0); assert.equal(f.$('connectionBadge').textContent,'Pairing code missing'); app.dispose();
  const g = fixture(); const second=await runtime(g); await second.start(); g.sockets[0].onclose({code:1008}); assert.equal(g.timers.size,0); assert.equal(g.$('connectionBadge').textContent,'Invalid pairing code'); second.dispose();
});

test('measured stats use received frame size and byte deltas rather than configured quality', async () => {
  const f=fixture(); const app=await runtime(f); await app.start();
  await f.sockets[0].onmessage({data:JSON.stringify({type:'signal',payload:{description:{type:'offer',sdp:'offer'}}})});
  const peer=f.peers[0]; peer.ontrack({track:track('video')}); peer.connectionState='connected'; peer.onconnectionstatechange();
  let bytes=1000; let timestamp=1000; peer.getStats=async()=>new Map([['v',{id:'v',type:'inbound-rtp',kind:'video',bytesReceived:bytes,timestamp}]]);
  await [...f.timers.values()][0](); assert.equal(f.$('stats').textContent,'1920×1080'); bytes=1001000; timestamp=2000;
  await [...f.timers.values()][0](); assert.equal(f.$('stats').textContent,'1920×1080 · 8.0 Mbps'); app.dispose();
});

test('keyboard playback shortcuts ignore input fields and modifiers; volume and mute remain synchronized', async () => {
  const f = fixture(); const app = await runtime(f); await app.start();
  f.$('playButton').disabled = false; f.$('muteButton').disabled = false; f.$('volume').disabled = false;
  let prevented = false;
  const key = (value, extra = {}) => f.env.document.listeners.keydown({key:value,target:{closest:()=>null},preventDefault(){prevented = true;},...extra});
  await key('m', {target:{closest:()=>({})}}); assert.equal(f.$('stream').muted,false);
  await key('m', {metaKey:true}); assert.equal(f.$('stream').muted,false);
  await key('m'); assert.equal(f.$('stream').muted,true); assert.equal(prevented,true);
  f.$('volume').value = '0.45'; f.$('volume').listeners.input(); assert.equal(f.$('stream').volume,0.45); assert.equal(f.$('stream').muted,false);
  await key(' '); assert.equal(f.$('stream').paused,false); await key(' '); assert.equal(f.$('stream').paused,true); app.dispose();
});
