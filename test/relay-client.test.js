import test from 'node:test';
import assert from 'node:assert/strict';
import { RelaySession } from '../src/relay-client.js';

test('publisher credentials stay in authorization headers; redirects fail closed', async () => {
  const calls = [];
  const client = new RelaySession(async (url, options) => {
    calls.push({ url, options });
    return Response.json(options.method === 'POST' ? { url: 'wss://example.com/livekit', token: 'jwt', password: 'generated', viewerUrl: 'https://example.com' } : { ok: true });
  });
  await client.create('https://example.com/', 'private-key');
  assert.equal(calls[0].url, 'https://example.com/api/session');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer private-key');
  assert.equal(calls[0].options.redirect, 'error');
  await assert.rejects(client.create('https://example.com', 'other'), /End the current/);
  await client.end();
  assert.equal(calls[1].options.method, 'DELETE');
  assert.equal(client.active, false);
});

test('failed revocation retains credentials so the user can retry', async () => {
  let fail = true;
  const client = new RelaySession(async (_url, options) => {
    if (options.method === 'DELETE' && fail) return Response.json({ error: 'failure' }, { status: 503 });
    return Response.json({ token: 'jwt', url: 'wss://example.com/livekit' });
  });
  await client.create('https://example.com', 'private-key');
  await assert.rejects(client.end(), /503/);
  assert.equal(client.active, true);
  fail = false;
  await client.end();
  assert.equal(client.active, false);
});

test('a rejected publisher key does not lock out a corrected key', async () => {
  const client = new RelaySession(async (_url, options) => options.headers.Authorization === 'Bearer wrong' ? Response.json({}, { status: 401 }) : Response.json({ token: 'jwt' }));
  await assert.rejects(client.create('https://example.com', 'wrong'), /401/);
  assert.equal(client.active, false);
  await client.create('https://example.com', 'correct');
  assert.equal(client.active, true);
});
