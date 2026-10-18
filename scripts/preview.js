// Design preview: serves the studio with a mocked desktop bridge (synthetic screen + tone) next to a real LAN
// share server, so host.html and the viewer can be iterated on in any browser. Development only.
import http from 'node:http';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { createShareServer } from '../src/server.js';

const port = Number(process.env.CHDSS_PREVIEW_PORT ?? 41792);
const share = await createShareServer({ port: 0, token: 'preview-viewer', hostToken: 'preview-host', host: '127.0.0.1' });
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

const mock = `(() => {
  let audioCallback, failureCallback, timer, number = 0, captureId;
  const origin = location.origin;
  window.chdss = {
    details: async () => ({ hostToken: 'preview-host', version: ${JSON.stringify(version)}, platform: 'darwin', screenPermission: 'granted',
      networkAddresses: [{ adapter: 'en0', address: '127.0.0.1', family: 'IPv4', url: origin + '/#preview-viewer' }, { adapter: 'ZeroTier', address: '10.147.17.4', family: 'IPv4', url: 'http://10.147.17.4:${port}/#preview-viewer' }],
      viewerUrls: [origin + '/#preview-viewer'] }),
    sources: async () => [{ id: 'screen:0:0', name: 'Built-in Retina Display' }, { id: 'window:123:0', name: 'Figma — CHDSS 3 Studio' }],
    selectSource: async () => {}, setSharing: async () => {}, copy: async text => navigator.clipboard?.writeText(text).catch(() => {}), openPermissions: async () => {}, onCommand: () => {},
    onAudio: callback => { audioCallback = callback; return () => { audioCallback = null; }; },
    onAudioFailure: callback => { failureCallback = callback; return () => { failureCallback = null; }; },
    startAudio: async source => {
      captureId = 'preview-' + (++number);
      let phase = 0;
      timer = setInterval(() => {
        const pcm = new Float32Array(1920);
        const swell = 0.08 + 0.14 * Math.abs(Math.sin(performance.now() / 700));
        for (let n = 0; n < 960; n++) { const value = Math.sin(phase++ * 2 * Math.PI * 220 / 48000) * swell; pcm[n * 2] = value; pcm[n * 2 + 1] = value; }
        audioCallback?.({ captureId, samples: new Uint8Array(pcm.buffer) });
      }, 20);
      return { captureId, sampleRate: 48000, channels: 2, scope: source.startsWith('window:') ? 'application' : 'display' };
    },
    stopAudio: async () => { clearInterval(timer); },
    createRelay: async () => { throw new Error('The design preview has no relay server.'); }, endRelay: async () => {}
  };
  navigator.mediaDevices.getDisplayMedia = async () => {
    const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
    const ctx = canvas.getContext('2d'); let frame = 0;
    const draw = () => {
      frame++;
      const gradient = ctx.createLinearGradient(0, 0, 1280, 720); gradient.addColorStop(0, '#1d2b33'); gradient.addColorStop(1, '#3a2a24');
      ctx.fillStyle = gradient; ctx.fillRect(0, 0, 1280, 720);
      ctx.fillStyle = '#e9e6df'; ctx.fillRect(140, 110, 760, 470); ctx.fillStyle = '#c9c5bb'; ctx.fillRect(140, 110, 760, 34);
      ctx.fillStyle = '#222'; ctx.font = '600 44px Helvetica'; ctx.fillText('Quarterly roadmap', 180, 220);
      ctx.font = '22px Helvetica'; for (let i = 0; i < 7; i++) { ctx.fillStyle = i === (Math.floor(frame / 30) % 7) ? '#ff5b35' : '#555'; ctx.fillText('— Item ' + (i + 1) + ' · shipped in sprint ' + (12 + i), 180, 280 + i * 40); }
      ctx.fillStyle = '#ff5b35'; ctx.fillRect(960 + Math.sin(frame / 25) * 120, 300, 90, 90);
      ctx.fillStyle = '#fff'; ctx.font = '600 28px monospace'; ctx.fillText(new Date().toLocaleTimeString(), 960, 640);
    };
    draw(); const interval = setInterval(draw, 33);
    const stream = canvas.captureStream(30); const track = stream.getVideoTracks()[0];
    const stop = track.stop.bind(track); track.stop = () => { clearInterval(interval); stop(); };
    return stream;
  };
})();`;

const server = http.createServer(async (request, response) => {
  if (request.url === '/__preview-mock.js') { response.writeHead(200, { 'content-type': 'text/javascript' }); response.end(mock); return; }
  if (request.url.split('?')[0] === '/host.html') {
    const html = await readFile(new URL('../public/host.html', import.meta.url), 'utf8');
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(html.replace('<script type="module"', '<script src="/__preview-mock.js"></script>\n  <script type="module"'));
    return;
  }
  const upstream = http.request({ host: '127.0.0.1', port: share.port, path: request.url, method: request.method, headers: request.headers }, reply => {
    // Never cache while iterating on the design.
    response.writeHead(reply.statusCode, { ...reply.headers, 'cache-control': 'no-store' }); reply.pipe(response);
  });
  upstream.on('error', () => { response.writeHead(502); response.end(); });
  request.pipe(upstream);
});
server.on('upgrade', (request, socket, head) => {
  const upstream = net.connect(share.port, '127.0.0.1', () => {
    upstream.write(`${request.method} ${request.url} HTTP/1.1\r\n${Object.entries(request.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`);
    upstream.write(head); upstream.pipe(socket); socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Studio preview: http://127.0.0.1:${port}/host.html`);
  console.log(`Viewer preview: http://127.0.0.1:${port}/#preview-viewer`);
});
