import test from 'node:test';
import assert from 'node:assert/strict';

const load = () => import('../public/filtered-audio.js');
function environment() {
  const track = { kind: 'audio', stop() { this.stopped = true; } };
  let dataHandler, failureHandler, stopped = 0;
  const sent = [];
  const bridge = {
    async startAudio() { return { captureId: 'capture-1', scope: 'application', sampleRate: 48000, channels: 2 }; },
    async stopAudio() { stopped++; },
    onAudio(handler) { dataHandler = handler; return () => { dataHandler = null; }; },
    onAudioFailure(handler) { failureHandler = handler; return () => { failureHandler = null; }; }
  };
  const context = {
    sampleRate: 48000, audioWorklet: { async addModule() {} }, async resume() {}, async close() { this.closed = true; },
    createMediaStreamDestination() { return { stream: { getAudioTracks: () => [track] } }; }
  };
  const node = { port: { postMessage(value) { sent.push(value); } }, connect() {}, disconnect() {} };
  return { bridge, context, node, track, sent, data: packet => dataHandler?.(packet), fail: packet => failureHandler?.(packet), stopped: () => stopped };
}

test('renderer creates only a filtered media track and rejects stale PCM', async () => {
  const { FilteredAudio } = await load();
  const env = environment();
  const audio = new FilteredAudio(env.bridge, { contextFactory: () => env.context, nodeFactory: () => env.node });
  const result = await audio.start('window:123:0');
  assert.equal(result.track, env.track);
  const samples = new Uint8Array(new Float32Array([0.5, -0.25]).buffer);
  env.data({ captureId: 'old', samples });
  assert.equal(env.sent.length, 0);
  env.data({ captureId: 'capture-1', samples });
  assert.deepEqual([...env.sent[0]], [0.5, -0.25]);
  await audio.stop();
  assert.equal(env.stopped(), 1);
  assert.ok(env.track.stopped);
  assert.ok(env.context.closed);
});

test('filter failure is surfaced rather than replaced by loopback', async () => {
  const { FilteredAudio } = await load();
  const env = environment();
  let failure;
  const audio = new FilteredAudio(env.bridge, { contextFactory: () => env.context, nodeFactory: () => env.node, onFailure: message => { failure = message; } });
  await audio.start('screen:0:0');
  env.fail({ captureId: 'old', message: 'Ignore' });
  assert.equal(failure, undefined);
  env.fail({ captureId: 'capture-1', message: 'Capture revoked' });
  assert.equal(failure, 'Capture revoked');
  await audio.stop();
});

test('helper failure arriving before the start reply cannot be lost', async () => {
  const { FilteredAudio } = await load();
  const env = environment();
  env.bridge.startAudio = async () => {
    env.fail({ captureId: 'capture-1', message: 'Crash immediately after ready' });
    return { captureId: 'capture-1', scope: 'display' };
  };
  const audio = new FilteredAudio(env.bridge, { contextFactory: () => env.context, nodeFactory: () => env.node });
  await assert.rejects(audio.start('screen:0:0'), /Crash immediately/);
  assert.ok(audio.closed);
});

test('a delayed processor error from a stopped capture cannot stop a new share', async () => {
  const { FilteredAudio } = await load();
  const env = environment();
  let failures = 0;
  const audio = new FilteredAudio(env.bridge, { contextFactory: () => env.context, nodeFactory: () => env.node, onFailure: () => { failures++; } });
  await audio.start('screen:0:0');
  const staleCallback = env.node.onprocessorerror;
  await audio.stop();
  staleCallback();
  assert.equal(failures, 0);
});
