import { request } from 'node:http';

// Only signaling is public; RoomService/Twirp stays on the loopback API.
// Access tokens occur in the LiveKit protocol's query string, never in logs.
export function attachSignalingProxy(server, { upstream, authorize, sockets }) {
  function target(req, upgrade = false) {
    const headers = {};
    for (const name of ['authorization', 'origin', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol']) {
      if (req.headers[name]) headers[name] = req.headers[name];
    }
    if (upgrade) { headers.connection = 'Upgrade'; headers.upgrade = 'websocket'; }
    return request(new URL(req.url.slice('/livekit'.length), upstream), { method: 'GET', headers });
  }
  function reject(socket, status) {
    socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`);
  }
  server.on('upgrade', async (req, socket, head) => {
    socket.on('error', () => {});
    if (req.method !== 'GET' || !['/livekit/rtc', '/livekit/rtc/v1'].includes(req.url.split('?')[0]) || req.headers.upgrade?.toLowerCase() !== 'websocket') return reject(socket, 404);
    try { await authorize(req); } catch (error) { return reject(socket, error.status ?? 401); }
    if (socket.destroyed) return;
    // Register before contacting the SFU so revoke also cancels pending upgrades.
    sockets.add(socket);
    const proxy = target(req, true);
    const timeout = setTimeout(() => proxy.destroy(), 5000);
    socket.once('close', () => { clearTimeout(timeout); sockets.delete(socket); proxy.destroy(); });
    proxy.on('error', () => { clearTimeout(timeout); socket.destroy(); });
    proxy.on('response', response => { clearTimeout(timeout); response.resume(); reject(socket, response.statusCode ?? 502); });
    proxy.on('upgrade', (response, remote, remoteHead) => {
      clearTimeout(timeout);
      if (socket.destroyed) return remote.destroy();
      remote.on('error', () => socket.destroy());
      socket.once('close', () => remote.destroy());
      remote.once('close', () => socket.destroy());
      const headers = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade'];
      for (const name of ['sec-websocket-accept', 'sec-websocket-protocol', 'sec-websocket-extensions']) if (response.headers[name]) headers.push(`${name}: ${response.headers[name]}`);
      socket.write(headers.join('\r\n') + '\r\n\r\n');
      if (remoteHead.length) socket.write(remoteHead);
      if (head.length) remote.write(head);
      remote.pipe(socket); socket.pipe(remote);
    });
    proxy.end();
  });
  return {
    async http(req, res) {
      let origin;
      try { origin = await authorize(req); }
      catch (error) { res.writeHead(error.status ?? 401); return res.end(); }
      if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
      const proxy = target(req);
      const timeout = setTimeout(() => proxy.destroy(), 5000);
      res.once('close', () => { clearTimeout(timeout); proxy.destroy(); });
      proxy.on('error', () => { clearTimeout(timeout); if (!res.headersSent) res.writeHead(502); res.end(); });
      proxy.on('response', response => {
        clearTimeout(timeout);
        res.writeHead(response.statusCode ?? 502, { 'Content-Type': 'text/plain' });
        response.pipe(res);
      });
      proxy.end();
    },
  };
}
