import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';

const load = () => import('../src/native-audio.js');
const fixture = (mode = 'ready') => (_command, args) => spawn(process.execPath, ['--input-type=module', '-e', `
  const mode = ${JSON.stringify(mode)};
  if (mode === 'error') { console.error(JSON.stringify({type:'error',message:'Filtering denied'})); process.exit(1); }
  if (mode === 'wrong-format') console.error(JSON.stringify({type:'ready',sampleRate:44100,channels:2,scope:'display'}));
  else console.error(JSON.stringify({type:'ready',sampleRate:48000,channels:2,scope:'display'}));
  const block = Buffer.alloc(7680); for (let n = 0; n < 1920; n++) block.writeFloatLE(0.25, n * 4);
  const timer = setInterval(() => { process.stdout.write(block.subarray(0,13)); process.stdout.write(block.subarray(13)); }, 20);
  process.stdin.resume(); process.stdin.on('end', () => { clearInterval(timer); process.exit(0); });
`, '--', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });

test('native PCM is framed into bounded stereo blocks with a capture identifier', async () => {
  const { NativeAudioCapture } = await load();
  const audio = new NativeAudioCapture({ spawn: fixture(), helperPath: 'fixture' });
  try {
    const ready = await audio.start('screen:0:0');
    const [packet] = await once(audio, 'data');
    assert.equal(ready.sampleRate, 48000);
    assert.equal(packet.captureId, ready.captureId);
    assert.equal(packet.samples.byteLength, 7680);
    assert.equal(new DataView(packet.samples.buffer, packet.samples.byteOffset).getFloat32(0, true), 0.25);
  } finally { await audio.stop(); }
});

test('native capture fails closed on helper denial and incompatible formats', async () => {
  const { NativeAudioCapture } = await load();
  for (const mode of ['error', 'wrong-format']) {
    const audio = new NativeAudioCapture({ spawn: fixture(mode), helperPath: 'fixture' });
    await assert.rejects(audio.start('screen:0:0'), /Filtering denied|format/);
    await audio.stop();
  }
});

test('source IDs are validated before a native process can be launched', async () => {
  const { NativeAudioCapture } = await load();
  let launches = 0;
  const audio = new NativeAudioCapture({ spawn() { launches++; throw new Error('Should not run'); } });
  for (const id of ['screen:0:0;whoami', 'window:12', 'window:-1:0', 'anything', null]) await assert.rejects(audio.start(id), /source/i);
  assert.equal(launches, 0);
});

test('stop during native startup prevents a late ready result', async () => {
  const { NativeAudioCapture } = await load();
  const audio = new NativeAudioCapture({ spawn: fixture(), helperPath: 'fixture' });
  const starting = audio.start('window:123:0');
  const rejected = assert.rejects(starting, /cancel|stop/i);
  await audio.stop();
  await rejected;
});

test('desktop capture can never request unfiltered loopback audio', async () => {
  const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.doesNotMatch(main, /audio:\s*'loopback'/);
  assert.match(main, /chdss:audio-start/);
  assert.match(main, /chdss:audio-stop/);
});

test('overlapping stops await helper exit before another capture can spawn', async () => {
  const { NativeAudioCapture } = await load();
  const children = [];
  let overlap = false;
  const launch = (_command, args) => {
    if (children.some(child => child.exitCode === null)) overlap = true;
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      console.error(JSON.stringify({type:'ready',sampleRate:48000,channels:2,scope:'display'}));
      process.stdin.resume(); process.stdin.on('end', () => setTimeout(() => process.exit(0), 150));
    `, '--', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child); return child;
  };
  const audio = new NativeAudioCapture({ spawn: launch, helperPath: 'fixture' });
  try {
    await audio.start('screen:0:0');
    const firstStop = audio.stop();
    await audio.stop();
    assert.notEqual(children[0].exitCode, null, 'a second stop must not complete while old helper remains alive');
    await audio.start('screen:0:0');
    await firstStop;
    assert.equal(overlap, false);
  } finally { await audio.stop(); }
});
