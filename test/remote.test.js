import test from 'node:test';
import assert from 'node:assert/strict';
import { RelayPublisher } from '../public/remote.js';

test('Internet publisher uses cloned tracks so disconnection cannot stop LAN capture', async () => {
  const published = [];
  let disconnected = false;
  const room = {
    remoteParticipants: new Map(), on() { return this; },
    async connect(_url, _token, options) { assert.equal(options.autoSubscribe, false); },
    async disconnect() { disconnected = true; },
    localParticipant: {
      async publishTrack(track, options) { published.push({ track, options }); },
      async unpublishTrack(track, stop) { assert.equal(stop, false); }
    }
  };
  const sdk = { Room: class { constructor() { return room; } }, RoomEvent: {}, Track: { Source: { ScreenShare: 'screen_share', ScreenShareAudio: 'screen_share_audio' } } };
  const clone = { kind: 'video', stopped: false, stop() { this.stopped = true; } };
  const original = { kind: 'video', clone: () => clone, stop() { assert.fail('LAN capture must survive remote disconnect'); } };
  const publisher = new RelayPublisher(() => {}, async () => sdk);
  await publisher.connect({ url: 'wss://example.com/livekit', token: 'jwt' });
  await publisher.publish({ getTracks: () => [original] }, { bitrate: 5_000_000, fps: 30 });
  assert.equal(published[0].track, clone);
  assert.equal(published[0].options.source, 'screen_share');
  await publisher.disconnect();
  assert.equal(disconnected, true);
  assert.equal(clone.stopped, true);
});

test('stop during an in-flight publish stops clones immediately and prevents late audio', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const published = [];
  const room = { remoteParticipants: new Map(), on() {}, async connect() {}, async disconnect() {}, localParticipant: {
    async publishTrack(track) { published.push(track); await pending; }, async unpublishTrack() {}
  } };
  const sdk = { Room: class { constructor() { return room; } }, RoomEvent: {}, Track: { Source: {} } };
  const clone = { kind: 'video', stopped: false, stop() { this.stopped = true; } };
  const publisher = new RelayPublisher(() => {}, async () => sdk);
  await publisher.connect({ url: 'wss://example.com', token: 'jwt' });
  const publication = publisher.publish({ getTracks: () => [{ clone: () => clone }, { clone: () => ({ kind: 'audio', stop() {} }) }] }, { bitrate: 1e6, fps: 30 });
  await new Promise(resolve => setImmediate(resolve));
  await publisher.unpublish();
  assert.equal(clone.stopped, true);
  release();
  await publication;
  assert.equal(published.length, 1);
});
