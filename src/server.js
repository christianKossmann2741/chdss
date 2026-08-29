import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, normalize } from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const send = (socket, message) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify(message));
const sameToken = (actual, expected) => {
  const a = Buffer.from(String(actual ?? ''));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
};

function staticPath(pathname) {
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const clean = normalize(requested);
  if (clean.startsWith('..') || clean.includes('\0')) return null;
  return join(publicDir, clean);
}

export async function createShareServer({ port = 41730, token, host = '0.0.0.0' }) {
  if (!token) throw new Error('A pairing token is required');
  let broadcaster = null;
  const viewers = new Map();
  const peers = new Map();

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/health') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ ok: true, broadcaster: broadcaster?.readyState === WebSocket.OPEN, viewers: viewers.size }));
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD' });
      response.end();
      return;
    }
    const path = staticPath(decodeURIComponent(url.pathname));
    if (!path) {
      response.writeHead(403);
      response.end('Forbidden');
      return;
    }
    try {
      const body = await readFile(path);
      response.writeHead(200, {
        'content-type': types[extname(path)] ?? 'application/octet-stream',
        'cache-control': extname(path) === '.html' ? 'no-store' : 'public, max-age=300',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'self'; connect-src 'self' ws:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:"
      });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500);
      response.end(error.code === 'ENOENT' ? 'Not found' : 'Server error');
    }
  });

  const wss = new WebSocketServer({ server, path: '/signal', maxPayload: 64 * 1024 });
  wss.on('connection', socket => {
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });
    let role = null;
    let viewerId = null;

    socket.on('message', raw => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch {
        send(socket, { type: 'error', code: 'bad-message', message: 'Invalid JSON' });
        return;
      }
      if (!role) {
        if (message.type !== 'hello' || !['host', 'viewer'].includes(message.role) || !sameToken(message.token, token)) {
          send(socket, { type: 'error', code: 'unauthorized', message: 'Invalid pairing code' });
          socket.close(1008, 'Unauthorized');
          return;
        }
        role = message.role;
        if (role === 'host') {
          if (broadcaster && broadcaster !== socket) broadcaster.close(1012, 'Host replaced');
          broadcaster = socket;
          send(socket, { type: 'ready', role: 'host' });
          for (const id of viewers.keys()) send(socket, { type: 'viewer-joined', viewerId: id });
        } else {
          viewerId = randomUUID();
          viewers.set(viewerId, socket);
          peers.set(socket, viewerId);
          send(socket, { type: 'ready', role: 'viewer', id: viewerId });
          if (broadcaster) send(broadcaster, { type: 'viewer-joined', viewerId });
        }
        return;
      }
      if (message.type !== 'signal' || typeof message.payload !== 'object' || message.payload === null) {
        send(socket, { type: 'error', code: 'bad-message', message: 'Unsupported message' });
        return;
      }
      if (role === 'host') {
        const target = viewers.get(String(message.viewerId));
        if (target) send(target, { type: 'signal', payload: message.payload });
      } else if (broadcaster) {
        send(broadcaster, { type: 'signal', viewerId, payload: message.payload });
      }
    });

    socket.on('close', () => {
      if (socket === broadcaster) {
        broadcaster = null;
        for (const viewer of viewers.values()) send(viewer, { type: 'host-left' });
      }
      const id = peers.get(socket);
      if (id) {
        peers.delete(socket);
        viewers.delete(id);
        if (broadcaster) send(broadcaster, { type: 'viewer-left', viewerId: id });
      }
    });
  });

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!socket.isAlive) { socket.terminate(); continue; }
      socket.isAlive = false;
      socket.ping();
    }
  }, 15_000);
  heartbeat.unref();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const actualPort = server.address().port;
  return {
    port: actualPort,
    localUrl: `http://127.0.0.1:${actualPort}`,
    wsUrl: `ws://127.0.0.1:${actualPort}/signal`,
    close: () => new Promise(resolve => {
      clearInterval(heartbeat);
      for (const socket of wss.clients) socket.terminate();
      wss.close(() => server.close(resolve));
    })
  };
}
