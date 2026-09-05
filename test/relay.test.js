import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { createRelayServer } from '../server/relay.js';

const ownerKey = 'a'.repeat(64);
const apiSecret = 's'.repeat(64);
const origin = 'https://stream.example.com';
async function fixture(t, options = {}) {
  const rooms = new Map();
  const calls = [];
  const roomService = {
    async listRooms() { return [...rooms.keys()].map(name => ({ name })); },
    async createRoom(config) { calls.push(['create', config]); rooms.set(config.name, []); return config; },
    async deleteRoom(name) { calls.push(['delete', name]); rooms.delete(name); },
    async listParticipants(name) { return rooms.get(name) || []; },
  };
  const app = createRelayServer({ ownerKey, apiKey: 'relay-key', apiSecret, publicOrigin: origin,
    livekitUrl: 'wss://stream.example.com/livekit', livekitHttpUrl: 'http://127.0.0.1:7880', roomService, ...options });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(() => app.close());
  async function request(path, { method = 'GET', body, headers = {} } = {}) {
    return fetch(base + path, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  const session = () => request('/api/session', { method: 'POST', headers: { Authorization: `Bearer ${ownerKey}`, Origin: 'http://127.0.0.1:12345' } });
  const join = password => request('/api/join', { method: 'POST', body: { password }, headers: { Origin: origin } });
  return { app, base, request, session, join, rooms, calls, roomService };
}
test('replacement and deletion revoke passwords; failed cleanup fails closed and retries', async t => {
  const f = await fixture(t);
  const first = await (await f.session()).json();
  const second = await (await f.session()).json();
  assert.notEqual(first.password, second.password);
  assert.equal(f.rooms.size, 1);
  assert.equal((await f.join(first.password)).status, 401);
  let fail = true;
  const original = f.roomService.deleteRoom;
  f.roomService.deleteRoom = async name => { if (fail) throw new Error('secret upstream failure'); return original(name); };
  const headers = { Authorization: `Bearer ${ownerKey}` };
  assert.equal((await f.request('/api/session', { method: 'DELETE', headers })).status, 503);
  assert.equal((await f.join(second.password)).status, 401);
  assert.equal((await f.session()).status, 503);
  fail = false;
  assert.equal((await f.request('/api/session', { method: 'DELETE', headers })).status, 204);
  assert.equal(f.rooms.size, 0);
});

test('concurrent session changes serialize and TTL sweep removes the active room', async t => {
  let now = Date.now();
  const f = await fixture(t, { now: () => now, maxSessionMs: 1000 });
  const responses = await Promise.all([f.session(), f.session(), f.session()]);
  assert.deepEqual(responses.map(r => r.status), [200, 200, 200]);
  assert.equal(f.rooms.size, 1);
  const last = await responses[2].json();
  now += 1001;
  await f.app.sweep();
  assert.equal(f.rooms.size, 0);
  assert.equal((await f.join(last.password)).status, 401);
});

test('origin policy is strict, bearer is always required, and query passwords are rejected', async t => {
  const f = await fixture(t);
  for (const Origin of ['null', 'https://evil.example', 'http://127.0.0.1:0', 'http://127.0.0.1:65536', 'http://127.0.0.1:0123', 'http://127.0.0.1:123/path']) {
    assert.equal((await f.request('/api/session', { method: 'POST', headers: { Origin, Authorization: `Bearer ${ownerKey}` } })).status, 403, Origin);
  }
  assert.equal((await f.request('/api/session', { method: 'POST', headers: { Origin: 'http://127.0.0.1:9876' } })).status, 401);
  const allowed = await f.request('/api/session', { method: 'OPTIONS', headers: { Origin: 'http://127.0.0.1:9876', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type' } });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://127.0.0.1:9876');
  assert.equal(allowed.headers.get('access-control-allow-credentials'), null);
  const session = await (await f.session()).json();
  for (const headers of [{}, { Origin: 'null' }, { Origin: 'https://evil.example' }]) {
    assert.equal((await f.request('/api/join', { method: 'POST', body: { password: session.password }, headers })).status, 403);
  }
  assert.equal((await f.request('/api/join?password=secret', { method: 'POST', body: {}, headers: { Origin: origin } })).status, 400);
});

test('JSON bodies are bounded and malformed data is a client error', async t => {
  const f = await fixture(t);
  for (const [body, expected] of [['{', 400], ['null', 400], ['[]', 400], [JSON.stringify({ password: 'x'.repeat(4096) }), 413]]) {
    const response = await fetch(f.base + '/api/join', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body });
    assert.equal(response.status, expected);
  }
  const response = await fetch(f.base + '/api/join', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(response.status, 415);
});

test('per-address and global attempt budgets cannot be bypassed with forwarded headers', async t => {
  const f = await fixture(t, { rateLimit: { windowMs: 60000, perIp: 2, global: 3, maxIps: 2 } });
  for (let i = 0; i < 2; i++) assert.equal((await f.request('/api/join', { method: 'POST', body: { password: 'wrong' }, headers: { Origin: origin, 'X-Forwarded-For': `1.2.3.${i}` } })).status, 401);
  assert.equal((await f.join('wrong')).status, 429);
  const g = await fixture(t, { trustLoopbackProxy: true, rateLimit: { windowMs: 60000, perIp: 5, global: 2, maxIps: 2 } });
  for (let i = 0; i < 2; i++) assert.equal((await g.request('/api/join', { method: 'POST', body: { password: 'wrong' }, headers: { Origin: origin, 'X-Forwarded-For': `1.2.3.${i}` } })).status, 401);
  assert.equal((await g.request('/api/join', { method: 'POST', body: {}, headers: { Origin: origin, 'X-Forwarded-For': '2.3.4.5' } })).status, 429);
});

test('12 viewer admissions reserve capacity for the sole publisher', async t => {
  const f = await fixture(t);
  const session = await (await f.session()).json();
  for (let i = 0; i < 12; i++) assert.equal((await f.join(session.password)).status, 200);
  assert.equal((await f.join(session.password)).status, 409);
});

test('static viewer assets are allowlisted with CSP; host files and traversal stay private', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'chdss-relay-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>Viewer</title>');
  await writeFile(join(dir, 'host.js'), 'private-host');
  await symlink(join(dir, 'host.js'), join(dir, 'viewer.js'));
  const f = await fixture(t, { publicDir: dir });
  const response = await f.request('/');
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Viewer/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  for (const path of ['/host.html', '/host.js', '/src/main.js', '/package.json', '/%2e%2e%2fpackage.json', '/viewer.js']) assert.equal((await f.request(path)).status, 404, path);
});

test('configuration rejects insecure origins unless explicitly loopback-only development', () => {
  const base = { ownerKey, apiKey: 'test', apiSecret, publicOrigin: origin, livekitUrl: 'wss://stream.example.com/livekit', livekitHttpUrl: 'http://127.0.0.1:7880' };
  for (const publicOrigin of ['http://stream.example.com', 'https://u:p@stream.example.com', 'https://stream.example.com/path', 'https://stream.example.com?x=y']) assert.throws(() => createRelayServer({ ...base, publicOrigin }), /origin|HTTPS/i);
  assert.throws(() => createRelayServer({ ...base, ownerKey: 'short' }), /key/i);
  assert.throws(() => createRelayServer({ ...base, livekitUrl: 'ws://stream.example.com' }), /WSS/i);
  assert.throws(() => createRelayServer({ ...base, dev: true, publicOrigin: 'http://example.com' }), /loopback|HTTPS/i);
});

test('signaling proxy checks active room credentials and rejects old tokens after deletion', async t => {
  let hits = 0;
  const upstream = http.createServer((req, res) => { hits++; assert.match(req.url, /^\/rtc\/v1\/validate\?/); res.end('valid'); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const f = await fixture(t, { livekitHttpUrl: `http://127.0.0.1:${upstream.address().port}` });
  const session = await (await f.session()).json();
  const path = `/livekit/rtc/v1/validate?access_token=${session.token}`;
  assert.equal((await f.request(path, { headers: { Origin: 'http://127.0.0.1:1111' } })).status, 200);
  assert.equal(hits, 1);
  assert.equal((await f.request('/livekit/twirp/livekit.RoomService/CreateRoom')).status, 404);
  await f.request('/api/session', { method: 'DELETE', headers: { Authorization: `Bearer ${ownerKey}` } });
  assert.equal((await f.request(path, { headers: { Origin: 'http://127.0.0.1:1111' } })).status, 401);
  assert.equal(hits, 1);
});

test('WebSocket signaling reaches the SFU and is disconnected when the session is revoked', async t => {
  const { WebSocketServer, WebSocket } = await import('ws');
  const upstream = http.createServer();
  const wsServer = new WebSocketServer({ server: upstream });
  wsServer.on('connection', socket => socket.send('sfu-ready'));
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { wsServer.close(); return new Promise(resolve => upstream.close(resolve)); });
  const f = await fixture(t, { livekitHttpUrl: `http://127.0.0.1:${upstream.address().port}` });
  const session = await (await f.session()).json();
  const socket = new WebSocket(f.base.replace('http:', 'ws:') + `/livekit/rtc/v1?access_token=${session.token}`, { origin: 'http://127.0.0.1:1111' });
  t.after(() => socket.terminate());
  const message = await new Promise((resolve, reject) => { socket.once('message', resolve); socket.once('error', reject); });
  assert.equal(String(message), 'sfu-ready');
  const closed = new Promise(resolve => socket.once('close', resolve));
  await f.request('/api/session', { method: 'DELETE', headers: { Authorization: `Bearer ${ownerKey}` } });
  await closed;
});

test('startup clears only CHDSS orphan rooms; shutdown revokes and closes the listener', async t => {
  const f = await fixture(t);
  f.rooms.set('chdss-orphan', []);
  f.rooms.set('unrelated', []);
  await f.app.initialize();
  assert.deepEqual([...f.rooms.keys()], ['unrelated']);
  await f.session();
  await f.app.close();
  assert.deepEqual([...f.rooms.keys()], ['unrelated']);
  assert.equal(f.app.server.listening, false);
});

test('slow JSON request returns 408 within the configured body deadline', async t => {
  const f = await fixture(t, { bodyTimeoutMs: 30 });
  const status = await new Promise((resolve, reject) => {
    const req = http.request(f.base + '/api/join', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'Content-Length': 10 } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.write('{');
  });
  assert.equal(status, 408);
});

function claims(token) { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url')); }

test('relay creates a private room and issues least-privilege signed viewer credentials', async t => {
  const f = await fixture(t);
  assert.deepEqual(await (await f.request('/health')).json(), { ok: true });
  assert.deepEqual(await (await f.request('/api/info')).json(), { mode: 'relay' });
  const response = await f.session();
  assert.equal(response.status, 200);
  const session = await response.json();
  assert.match(session.password, /^[A-Za-z0-9_-]{32,}$/);
  assert.equal(session.viewerUrl, origin);
  assert.equal(session.url, 'wss://stream.example.com/livekit');
  assert.equal(f.calls[0][1].maxParticipants, 13);
  const publisher = claims(session.token);
  assert.equal(publisher.video.canPublish, true);
  assert.equal(publisher.sub, 'host');
  const joined = await f.join(session.password);
  assert.equal(joined.status, 200);
  const viewer = await joined.json();
  const grant = claims(viewer.token);
  assert.equal(grant.video.room, session.room);
  assert.equal(grant.video.roomJoin, true);
  assert.equal(grant.video.canSubscribe, true);
  for (const name of ['canPublish', 'canPublishData', 'roomCreate', 'roomAdmin', 'canUpdateOwnMetadata']) assert.equal(grant.video[name], false);
  assert.equal(grant.exp - grant.nbf, 300);
  assert.notEqual(grant.sub, publisher.sub);
  const { TokenVerifier } = await import('../server/node_modules/livekit-server-sdk/dist/index.js');
  assert.equal((await new TokenVerifier('relay-key', apiSecret).verify(viewer.token)).sub, grant.sub);
});
