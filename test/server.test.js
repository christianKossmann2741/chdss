import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createShareServer } from '../src/server.js';

const openSocket = (url) => new Promise((resolve, reject) => {
  const socket = new WebSocket(url);
  socket.once('open', () => resolve(socket));
  socket.once('error', reject);
});

const nextMessage = (socket) => new Promise((resolve, reject) => {
  socket.once('message', data => resolve(JSON.parse(data.toString())));
  socket.once('error', reject);
});

test('server serves viewer without leaking the token and reports health', async (t) => {
  const share = await createShareServer({ port: 0, token: 'top-secret-token', host: '127.0.0.1' });
  t.after(() => share.close());
  const root = await fetch(`${share.localUrl}/`);
  const html = await root.text();
  assert.equal(root.status, 200);
  assert.match(html, /Christian's Handy Dandy Screen Share/);
  assert.doesNotMatch(html, /top-secret-token/);
  const health = await fetch(`${share.localUrl}/health`).then(r => r.json());
  assert.deepEqual(health, { ok: true, broadcaster: false, viewers: 0 });
});

test('signaling rejects a wrong pairing token', async (t) => {
  const share = await createShareServer({ port: 0, token: 'right-token', host: '127.0.0.1' });
  t.after(() => share.close());
  const socket = await openSocket(share.wsUrl);
  socket.send(JSON.stringify({ type: 'hello', role: 'viewer', token: 'wrong-token' }));
  const message = await nextMessage(socket);
  assert.deepEqual(message, { type: 'error', code: 'unauthorized', message: 'Invalid pairing code' });
  await new Promise(resolve => socket.once('close', resolve));
});

test('signaling routes viewer offer, answer, ICE, and disconnect lifecycle', async (t) => {
  const share = await createShareServer({ port: 0, token: 'right-token', host: '127.0.0.1' });
  t.after(() => share.close());
  const host = await openSocket(share.wsUrl);
  host.send(JSON.stringify({ type: 'hello', role: 'host', token: 'right-token' }));
  assert.deepEqual(await nextMessage(host), { type: 'ready', role: 'host' });

  const viewer = await openSocket(share.wsUrl);
  viewer.send(JSON.stringify({ type: 'hello', role: 'viewer', token: 'right-token' }));
  const viewerReady = await nextMessage(viewer);
  assert.equal(viewerReady.type, 'ready');
  assert.equal(viewerReady.role, 'viewer');
  assert.match(viewerReady.id, /^[a-f0-9-]+$/);
  assert.deepEqual(await nextMessage(host), { type: 'viewer-joined', viewerId: viewerReady.id });

  host.send(JSON.stringify({ type: 'signal', viewerId: viewerReady.id, payload: { description: { type: 'offer', sdp: 'offer-sdp' } } }));
  assert.deepEqual(await nextMessage(viewer), { type: 'signal', payload: { description: { type: 'offer', sdp: 'offer-sdp' } } });
  viewer.send(JSON.stringify({ type: 'signal', payload: { description: { type: 'answer', sdp: 'answer-sdp' } } }));
  assert.deepEqual(await nextMessage(host), { type: 'signal', viewerId: viewerReady.id, payload: { description: { type: 'answer', sdp: 'answer-sdp' } } });

  viewer.close();
  assert.deepEqual(await nextMessage(host), { type: 'viewer-left', viewerId: viewerReady.id });
  host.close();
});

test('signaling rejects oversized and unexpected messages', async (t) => {
  const share = await createShareServer({ port: 0, token: 'right-token', host: '127.0.0.1' });
  t.after(() => share.close());
  const socket = await openSocket(share.wsUrl);
  socket.send(JSON.stringify({ type: 'hello', role: 'viewer', token: 'right-token' }));
  await nextMessage(socket);
  socket.send(JSON.stringify({ type: 'admin-now-please' }));
  assert.deepEqual(await nextMessage(socket), { type: 'error', code: 'bad-message', message: 'Unsupported message' });
});
