import test from 'node:test';
import assert from 'node:assert/strict';
import { audioConstraints, tuneSender, connectionPolicy } from '../public/webrtc.js';

test('audio capture requests stereo 48 kHz with processing disabled', () => {
  assert.deepEqual(audioConstraints(), {
    channelCount: { ideal: 2 },
    sampleRate: { ideal: 48000 },
    sampleSize: { ideal: 16 },
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false
  });
});

test('tuneSender prioritizes motion and stable Opus audio', async () => {
  const changes = [];
  const video = { track: { kind: 'video', contentHint: '' }, getParameters: () => ({ encodings: [{}] }), setParameters: async p => changes.push(p) };
  const audio = { track: { kind: 'audio', contentHint: '' }, getParameters: () => ({ encodings: [{}] }), setParameters: async p => changes.push(p) };
  await tuneSender(video, { maxBitrate: 8_000_000, maxFramerate: 60 });
  await tuneSender(audio, {});
  assert.equal(video.track.contentHint, 'motion');
  assert.equal(audio.track.contentHint, 'music');
  assert.deepEqual(changes[0].encodings[0], { maxBitrate: 8_000_000, maxFramerate: 60, priority: 'high', networkPriority: 'high' });
  assert.deepEqual(changes[1].encodings[0], { maxBitrate: 192_000, priority: 'high', networkPriority: 'high' });
});

test('connection policy remains LAN-only with no public ICE servers', () => {
  assert.deepEqual(connectionPolicy(), { iceServers: [], bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
});
