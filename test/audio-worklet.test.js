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

function stream(node, { burstFrames = 0, seconds = 3 } = {}) {
  const chunk = new Float32Array(2560).fill(0.1); // 1280 frames = 10 render quanta
  if (burstFrames) for (let left = burstFrames; left > 0; left -= 1280) node.port.onmessage({ data: chunk });
  const output = [new Float32Array(128), new Float32Array(128)];
  let underruns = 0;
  for (let n = 0; n < seconds * 375; n++) {
    if (n % 10 === 0) node.port.onmessage({ data: chunk });
    node.process([], [output]);
    if (!node.buffering && output[0][127] === 0) underruns++;
  }
  return underruns;
}

test('a catch-up burst does not leave permanent audio delay: the buffer trims back to its cushion', async () => {
  const node = await processor();
  const messages = [];
  node.port.postMessage = message => messages.push(message);
  stream(node, { burstFrames: 8960 }); // ~187 ms arrives at once, as after a Windows helper stall
  assert.ok(node.trimmedFrames > 4800, `trimmed ${node.trimmedFrames}`);
  assert.ok(node.queuedFrames <= node.target + 1280 + 128, `queued ${node.queuedFrames}`);
  assert.ok(messages.some(message => message.type === 'buffer' && Number.isFinite(message.queuedFrames)));
});

test('a healthy stream is never trimmed or starved', async () => {
  const node = await processor();
  const underruns = stream(node, { burstFrames: 1280 });
  assert.equal(node.trimmedFrames, 0);
  assert.equal(underruns, 0);
});
