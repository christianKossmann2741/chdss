import test from 'node:test';
import assert from 'node:assert/strict';
import { presets, captureOptions, validateCapture, relayOrigin } from '../public/broadcast.js';

test('quality presets cap dimensions, frame rate and bandwidth', () => {
  assert.equal(presets.economy.height, 720);
  assert.equal(presets.economy.fps, 30);
  assert.equal(presets.motion.fps, 60);
  assert.deepEqual(captureOptions({ height: 1080, fps: 30 }, false), {
    video: { height: { ideal: 1080, max: 1080 }, frameRate: { ideal: 30, max: 30 } }, audio: false
  });
});

test('missing requested audio stops every track instead of silently downgrading', () => {
  let stopped = false;
  const video = { stop() { stopped = true; } };
  const stream = { getVideoTracks: () => [video], getAudioTracks: () => [], getTracks: () => [video] };
  assert.throws(() => validateCapture(stream, true), /system audio/i);
  assert.equal(stopped, true);
  assert.equal(validateCapture(stream, false).videoTrack, video);
});

test('relay endpoints require a bare HTTPS origin and never carry credentials', () => {
  assert.equal(relayOrigin('https://stream.example.com/'), 'https://stream.example.com');
  for (const url of ['http://example.com', 'https://a:b@example.com', 'https://example.com/foo', 'https://example.com?secret=x', 'https://example.com/#x', 'file:///tmp/a']) {
    assert.throws(() => relayOrigin(url), /HTTPS|origin/);
  }
});
