import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createShareServer } from '../src/server.js';
import { mkdir } from 'node:fs/promises';

const server = await createShareServer({ port: 0, token: 'filtered-smoke-viewer', hostToken: 'filtered-smoke-host', host: '127.0.0.1' });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const shots = process.env.CHDSS_SCREENSHOTS ?? '/tmp/chdss-2.1-filtered';
await mkdir(shots, { recursive: true });
const failures = [];
try {
  const context = await browser.newContext({ viewport: { width: 1160, height: 950 } });
  const host = await context.newPage();
  host.on('pageerror', error => failures.push(error.message));
  await host.addInitScript(({ url }) => {
    let audioCallback, failureCallback, timer, number = 0, captureId;
    window.nativeFixture = { deny: false, fail: () => failureCallback?.({ captureId, message: 'Native filtering revoked' }) };
    window.chdss = {
      details: async () => ({ hostToken: 'filtered-smoke-host', viewerUrls: [url + '/#filtered-smoke-viewer'], platform: 'darwin', screenPermission: 'granted' }),
      sources: async () => [{ id: 'screen:0:0', name: 'Test display' }, { id: 'window:123:0', name: 'Test application' }],
      selectSource: async () => {}, setSharing: async () => {}, copy: async () => {}, openPermissions: async () => {}, onCommand: () => {},
      onAudio: callback => { audioCallback = callback; return () => { audioCallback = null; }; },
      onAudioFailure: callback => { failureCallback = callback; return () => { failureCallback = null; }; },
      startAudio: async source => {
        if (window.nativeFixture.deny) throw new Error('Native filtering denied; no unfiltered fallback');
        captureId = `fixture-${++number}`;
        let phase = 0;
        timer = setInterval(() => {
          const pcm = new Float32Array(1920);
          for (let n = 0; n < 960; n++) {
            const value = Math.sin(phase++ * 2 * Math.PI * 440 / 48000) * 0.2;
            pcm[n * 2] = value; pcm[n * 2 + 1] = value;
          }
          audioCallback?.({ captureId, samples: new Uint8Array(pcm.buffer) });
        }, 20);
        return { captureId, sampleRate: 48000, channels: 2, scope: source.startsWith('window:') ? 'application' : 'display' };
      },
      stopAudio: async () => { clearInterval(timer); },
      createRelay: async () => { throw new Error('Not used'); }, endRelay: async () => {}
    };
    navigator.mediaDevices.getDisplayMedia = async options => {
      if (options.audio !== false) throw new Error('Unfiltered display audio was requested');
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const ctx = canvas.getContext('2d'); let frame = 0;
      const draw = () => { ctx.fillStyle = '#101114'; ctx.fillRect(0, 0, 640, 360); ctx.fillStyle = '#a5a0ff'; ctx.fillRect(frame++ % 580, 90, 60, 180); };
      draw(); const timer = setInterval(draw, 33);
      const stream = canvas.captureStream(30); const track = stream.getVideoTracks()[0];
      const stop = track.stop.bind(track); track.stop = () => { clearInterval(timer); stop(); };
      return stream;
    };
  }, { url: server.localUrl });
  await host.goto(server.localUrl + '/host.html');
  await host.waitForFunction(() => !document.getElementById('shareButton').disabled);
  await host.screenshot({ path: shots + '/studio-filtered.png', fullPage: true });
  const viewer = await context.newPage();
  viewer.on('pageerror', error => failures.push(error.message));
  await viewer.goto(server.localUrl + '/#filtered-smoke-viewer');
  const level = () => viewer.evaluate(async () => {
    const context = new AudioContext(); await context.resume();
    const stream = document.getElementById('stream').srcObject;
    const input = context.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    const analyser = context.createAnalyser(); analyser.fftSize = 512; input.connect(analyser);
    const samples = new Float32Array(512); let peak = 0;
    for (let n = 0; n < 25 && peak < 0.02; n++) {
      await new Promise(resolve => setTimeout(resolve, 100)); analyser.getFloatTimeDomainData(samples);
      peak = Math.max(...samples.map(Math.abs));
    }
    await context.close(); return peak;
  });
  await host.click('#shareButton');
  await viewer.waitForFunction(() => document.getElementById('stream').videoWidth > 0);
  const displayPeak = await level();
  assert.ok(displayPeak > 0.02, `PCM must reach decoded viewer audio, peak=${displayPeak}`);
  assert.match(await host.locator('#audioStatus').textContent(), /Discord excluded/);
  await host.click('#muteAudio');
  assert.match(await host.locator('#audioStatus').textContent(), /muted/);
  await host.click('#muteAudio');
  await host.click('#stopButton');
  await viewer.waitForFunction(() => !document.getElementById('stream').srcObject);
  await host.waitForFunction(() => !document.getElementById('shareButton').disabled);
  await host.selectOption('#source', 'window:123:0');
  await host.click('#shareButton');
  await viewer.waitForFunction(() => document.getElementById('stream').videoWidth > 0);
  assert.match(await host.locator('#audioStatus').textContent(), /Selected application/);
  const windowPeak = await level(); assert.ok(windowPeak > 0.02);
  await host.screenshot({ path: shots + '/window-audio-live.png', fullPage: true });
  await host.evaluate(() => window.nativeFixture.fail());
  await viewer.waitForFunction(() => !document.getElementById('stream').srcObject);
  await host.waitForFunction(() => document.getElementById('errorNotice').textContent.includes('revoked'));
  await host.waitForFunction(() => !document.getElementById('shareButton').disabled);
  await host.evaluate(() => { window.nativeFixture.deny = true; });
  await host.click('#shareButton');
  await host.waitForFunction(() => document.getElementById('errorNotice').textContent.includes('denied'));
  assert.equal(await host.evaluate(() => document.getElementById('preview').srcObject), null);
  await host.uncheck('#includeAudio');
  await host.click('#shareButton');
  await viewer.waitForFunction(() => document.getElementById('stream').videoWidth > 0);
  assert.equal(await viewer.evaluate(() => document.getElementById('stream').srcObject.getAudioTracks().length), 0);
  await host.click('#stopButton');
  assert.deepEqual(failures, []);
  console.log(JSON.stringify({ ok: true, verification: 'synthetic PCM -> actual AudioWorklet -> LAN WebRTC decoded samples', displayPeak, windowPeak, gates: ['scope labels', 'mute', 'stop/re-share', 'fatal helper stops share', 'startup denial no fallback', 'explicit video-only'], nativeOSCaptureVerified: false, screenshots: shots }, null, 2));
} finally { await browser.close(); await server.close(); }
