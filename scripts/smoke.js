import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createShareServer } from '../src/server.js';
import { createRelayServer } from '../server/relay.js';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const dir = await mkdtemp(join(tmpdir(), 'chdss-smoke-'));
const shots = process.env.CHDSS_SCREENSHOTS ?? join(dir, 'screenshots');
await mkdir(shots, { recursive: true });
const token = randomBytes(24).toString('hex');
const hostToken = randomBytes(32).toString('hex');
const ownerKey = randomBytes(32).toString('hex');
const apiSecret = randomBytes(48).toString('hex');
const container = `chdss-smoke-${process.pid}`;
let browser, lan, relay, tls;
const failures = [];
const wait = async (predicate, description) => {
  for (let i = 0; i < 60; i++) { try { if (await predicate()) return; } catch {} await new Promise(resolve => setTimeout(resolve, 500)); }
  throw Error(`Timed out: ${description}`);
};
try {
  await writeFile(join(dir, 'livekit.yml'), `port: 17880\nbind_addresses: [0.0.0.0]\nrtc:\n  tcp_port: 17881\n  udp_port: 17882\n  node_ip: 127.0.0.1\n  use_external_ip: false\nkeys:\n  testkey: ${apiSecret}\nlogging:\n  level: error\n`, { mode: 0o600 });
  execFileSync('docker', ['create', '--name', container, '-p', '127.0.0.1:17880:17880', '-p', '127.0.0.1:17881:17881', 'livekit/livekit-server:v1.13.6', '--config', '/etc/livekit.yml'], { stdio: 'pipe' });
  execFileSync('docker', ['cp', join(dir, 'livekit.yml'), `${container}:/etc/livekit.yml`], { stdio: 'pipe' });
  execFileSync('docker', ['start', container], { stdio: 'pipe' });
  try { await wait(async () => (await fetch('http://127.0.0.1:17880/', { signal: AbortSignal.timeout(1000) })).ok, 'LiveKit readiness'); }
  catch (error) { console.error(execFileSync('docker', ['logs', container], { encoding: 'utf8' }).replaceAll(apiSecret, '[REDACTED]')); throw error; }
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'pipe' });
  tls = https.createServer({ key: await readFile(join(dir, 'key.pem')), cert: await readFile(join(dir, 'cert.pem')) }, (req, res) => {
    const proxy = http.request({ hostname: '127.0.0.1', port: relay.server.address().port, path: req.url, method: req.method, headers: req.headers }, upstream => { res.writeHead(upstream.statusCode, upstream.headers); upstream.pipe(res); });
    proxy.on('error', () => { res.writeHead(502).end(); }); req.pipe(proxy);
  });
  tls.on('upgrade', (req, socket, head) => {
    const upstream = net.connect(relay.server.address().port, '127.0.0.1', () => {
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket);
    });
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy()); socket.on('close', () => upstream.destroy()); upstream.on('close', () => socket.destroy());
  });
  await new Promise(resolve => tls.listen(0, '127.0.0.1', resolve));
  const origin = `https://127.0.0.1:${tls.address().port}`;
  relay = createRelayServer({ ownerKey, apiKey: 'testkey', apiSecret, publicOrigin: origin, livekitUrl: origin.replace('https:', 'wss:') + '/livekit', livekitHttpUrl: 'http://127.0.0.1:17880', publicDir: resolve('public') });
  await relay.initialize();
  await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
  const relayLocal = `http://127.0.0.1:${relay.server.address().port}`;
  const sessionRequest = async method => {
    const response = await fetch(relayLocal + '/api/session', { method, headers: { Authorization: `Bearer ${ownerKey}` } });
    assert.ok(response.ok, `session ${method} HTTP ${response.status}`);
    return response.status === 204 ? {} : response.json();
  };
  lan = await createShareServer({ port: 0, token, hostToken, host: '127.0.0.1' });
  browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--ignore-certificate-errors'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1160, height: 850 } });
  const host = await context.newPage();
  host.on('pageerror', error => failures.push(error.message));
  host.on('requestfailed', request => console.log('Host request failed:', new URL(request.url()).pathname, request.failure()?.errorText));
  await host.exposeFunction('testCreateRelay', () => sessionRequest('POST'));
  await host.exposeFunction('testEndRelay', () => sessionRequest('DELETE'));
  await host.addInitScript(({ token, hostToken, url }) => {
    let audioCallback, audioTimer, captureNumber = 0;
    window.chdss = {
      details: async () => ({ hostToken, viewerUrls: [url + '/#' + token], platform: 'darwin', screenPermission: 'granted' }),
      sources: async () => [{ id: 'synthetic-screen', name: 'Synthetic test screen' }], selectSource: async () => {},
      onAudio: callback => { audioCallback = callback; return () => { audioCallback = null; }; },
      onAudioFailure: () => () => {},
      startAudio: async () => {
        const captureId = `synthetic-${++captureNumber}`;
        let phase = 0;
        clearInterval(audioTimer);
        audioTimer = setInterval(() => {
          const samples = new Float32Array(1920);
          for (let frame = 0; frame < 960; frame++) {
            const value = 0.15 * Math.sin(phase++ * 2 * Math.PI * 440 / 48000);
            samples[frame * 2] = value; samples[frame * 2 + 1] = value;
          }
          audioCallback?.({ captureId, samples: new Uint8Array(samples.buffer) });
        }, 20);
        return { captureId, sampleRate: 48000, channels: 2, scope: 'display' };
      },
      stopAudio: async () => { clearInterval(audioTimer); },
      setSharing: async () => {}, copy: async () => {}, openPermissions: async () => {}, onCommand: () => {},
      createRelay: () => window.testCreateRelay(), endRelay: () => window.testEndRelay()
    };
    navigator.mediaDevices.getDisplayMedia = async options => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const ctx = canvas.getContext('2d'); let frame = 0;
      const draw = () => { ctx.fillStyle = '#131923'; ctx.fillRect(0, 0, 640, 360); ctx.fillStyle = '#a5a0ff'; ctx.fillRect(frame++ % 600, 130, 40, 100); ctx.font = '28px sans-serif'; ctx.fillText('CHDSS · synthetic transport test', 65, 75); };
      draw(); const timer = setInterval(draw, 33);
      const stream = canvas.captureStream(30);
      if (options.audio) throw new Error('Transport smoke must never request unfiltered display audio.');
      const track = stream.getVideoTracks()[0];
      const stop = track.stop.bind(track);
      track.stop = () => { clearInterval(timer); stop(); };
      return stream;
    };
  }, { token, hostToken, url: lan.localUrl });
  await host.goto(lan.localUrl + '/host.html');
  await host.waitForFunction(() => !document.getElementById('shareButton').disabled);
  await host.screenshot({ path: join(shots, 'studio.png'), fullPage: true });
  const viewer = await context.newPage();
  viewer.on('pageerror', error => failures.push(error.message));
  await viewer.goto(lan.localUrl + '/#' + token);
  await host.click('#shareButton');
  await viewer.waitForFunction(() => document.getElementById('stream').videoWidth > 0);
  assert.equal(await viewer.evaluate(() => document.getElementById('stream').srcObject.getAudioTracks().length), 1);
  await host.click('#stopButton');
  await viewer.waitForFunction(() => !document.getElementById('stream').srcObject);
  await host.click('#shareButton');
  await viewer.waitForFunction(() => document.getElementById('stream').videoWidth > 0);
  console.log('PASS: LAN audio/video and stop/re-share through real browser UI');
  await host.click('#modeInternet');
  await host.fill('#serverUrl', origin); await host.fill('#publisherKey', 'test-managed-key');
  await host.click('#remoteConnect');
  try { await host.waitForFunction(() => !document.getElementById('remoteInvite').classList.contains('hidden'), null, { timeout: 30000 }); }
  catch (error) {
    console.error('Internet UI:', await host.locator('#remoteStatus').textContent(), await host.locator('#errorNotice').textContent());
    console.error('SFU:', execFileSync('docker', ['logs', container], { encoding: 'utf8' }).replaceAll(apiSecret, '[REDACTED]'));
    throw error;
  }
  const password = await host.inputValue('#streamPassword');
  const remote = await context.newPage(); remote.on('pageerror', error => failures.push(error.message));
  await remote.goto(origin);
  await remote.waitForSelector('#unlockPanel:not(.hidden)');
  await remote.screenshot({ path: join(shots, 'unlock.png'), fullPage: true });
  await remote.fill('#joinPassword', 'incorrect'); await remote.click('#joinButton');
  await remote.waitForFunction(() => document.getElementById('joinError').textContent.includes('not accepted'));
  await remote.fill('#joinPassword', password); await remote.click('#joinButton');
  await remote.waitForFunction(() => document.getElementById('stream').videoWidth > 0, { timeout: 30000 });
  assert.equal(await remote.evaluate(() => document.getElementById('stream').srcObject.getAudioTracks().length), 1);
  const audioLevel = await remote.evaluate(async () => {
    const audio = new AudioContext(); await audio.resume();
    const input = audio.createMediaStreamSource(new MediaStream(document.getElementById('stream').srcObject.getAudioTracks()));
    const analyser = audio.createAnalyser(); analyser.fftSize = 512; input.connect(analyser);
    const samples = new Float32Array(512); let peak = 0;
    for (let i = 0; i < 20 && peak < 0.01; i++) {
      await new Promise(resolve => setTimeout(resolve, 100)); analyser.getFloatTimeDomainData(samples);
      peak = Math.max(...samples.map(Math.abs));
    }
    await audio.close(); return peak;
  });
  assert.ok(audioLevel > 0.01, 'decoded audio samples cross the SFU, not just an empty audio track');
  await remote.waitForFunction(() => document.getElementById('stats').textContent.includes('640'));
  await remote.screenshot({ path: join(shots, 'relay-playing.png'), fullPage: true });
  await remote.click('#muteButton');
  assert.equal(await remote.evaluate(() => document.getElementById('stream').muted), true);
  await remote.setViewportSize({ width: 390, height: 844 });
  await remote.screenshot({ path: join(shots, 'mobile.png'), fullPage: true });
  assert.ok(await remote.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile has no horizontal overflow');
  await host.click('#remoteDisconnect');
  await remote.waitForSelector('#unlockPanel:not(.hidden)');
  await remote.fill('#joinPassword', password); await remote.click('#joinButton');
  await remote.waitForFunction(() => document.getElementById('joinError').textContent.includes('not accepted'));
  assert.ok(await viewer.evaluate(() => document.getElementById('stream').videoWidth > 0), 'LAN survives remote disconnect');
  console.log('PASS: real LiveKit SFU carries audio/video, password rejection, revocation, responsive viewer, LAN isolation');
  assert.deepEqual(failures, [], 'no unhandled browser exceptions');
  console.log(`Screenshots: ${shots}`);
} finally {
  await browser?.close();
  await relay?.close();
  if (tls) await new Promise(resolve => tls.close(resolve));
  await lan?.close();
  try { execFileSync('docker', ['rm', '-f', container], { stdio: 'pipe' }); } catch {}
  await rm(dir, { recursive: true, force: true });
}
