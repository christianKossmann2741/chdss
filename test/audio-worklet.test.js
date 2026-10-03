import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

async function processor() {
  let Processor;
  const context = vm.createContext({ Float32Array, Number, Math, AudioWorkletProcessor: class { constructor() { this.port = {}; } }, registerProcessor(_name, value) { Processor = value; } });
  vm.runInContext(await readFile(new URL('../public/audio-worklet.js', import.meta.url), 'utf8'), context);
  return new Processor();
}

test('native audio worklet preserves stereo and waits for a short prebuffer', async () => {
  const node = await processor();
  const output = [new Float32Array(128), new Float32Array(128)];
  node.process([], [output]);
  assert.equal(output[0][0], 0);
  const pcm = new Float32Array(3840);
  for (let i = 0; i < pcm.length; i += 2) { pcm[i] = 0.25; pcm[i + 1] = -0.5; }
  node.port.onmessage({ data: pcm });
  node.process([], [output]);
  assert.equal(output[0][127], 0.25);
  assert.equal(output[1][127], -0.5);
});

test('native audio worklet bounds latency and never emits NaN from malformed input', async () => {
  const node = await processor();
  const pcm = new Float32Array(1920).fill(0.25);
  for (let n = 0; n < 100; n++) node.port.onmessage({ data: pcm });
  assert.ok(node.queuedFrames <= 9600);
  pcm[0] = NaN; pcm[1] = Infinity;
  node.port.onmessage({ data: pcm });
  const output = [new Float32Array(128), new Float32Array(128)];
  for (let n = 0; n < 100; n++) node.process([], [output]);
  assert.ok(output.every(channel => channel.every(Number.isFinite)));
});
