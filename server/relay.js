import http from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachSignalingProxy } from './signaling.js';
import { isIP } from 'node:net';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { AccessToken, RoomServiceClient, TokenVerifier } from 'livekit-server-sdk';

const hash = value => createHash('sha256').update(value).digest();
const loopback = ip => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
const electronOrigin = origin => {
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(origin ?? '');
  return !!match && Number(match[1]) <= 65535;
};
const fail = (status, message) => Object.assign(new Error(message), { status });

function limiter(config, now) {
  const { windowMs = 60000, perIp = 30, global = 300, maxIps = 4096 } = config ?? {};
  let end = 0, total = 0;
  const ips = new Map();
  return ip => {
    if (now() >= end) { end = now() + windowMs; total = 0; ips.clear(); }
    if (++total > global) return false;
    if (!ips.has(ip) && ips.size >= maxIps) return false;
    const count = (ips.get(ip) ?? 0) + 1;
    ips.set(ip, count);
    return count <= perIp;
  };
}

function jsonBody(req, timeoutMs) {
  if (!/^application\/json(?:\s*;.*)?$/i.test(req.headers['content-type'] ?? '')) throw fail(415, 'JSON required');
  if (Number(req.headers['content-length']) > 2048) throw fail(413, 'Body too large');
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const timer = setTimeout(() => done(fail(408, 'Request timed out')), timeoutMs);
    function done(error, value) {
      clearTimeout(timer);
      req.off('data', onData); req.off('end', onEnd); req.off('error', onError); req.off('aborted', onAbort);
      if (error) { req.resume(); reject(error); } else resolve(value);
    }
    function onData(chunk) { size += chunk.length; if (size > 2048) done(fail(413, 'Body too large')); else chunks.push(chunk); }
    function onError() { done(fail(400, 'Invalid request')); }
    function onAbort() { done(fail(400, 'Incomplete request')); }
    function onEnd() {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error();
        done(null, body);
      } catch { done(fail(400, 'Invalid JSON')); }
    }
    req.on('data', onData); req.on('end', onEnd); req.on('error', onError); req.on('aborted', onAbort);
  });
}

export function createRelayServer(options) {
  const { ownerKey, apiKey, apiSecret, publicOrigin, livekitUrl, livekitHttpUrl } = options;
  const originURL = new URL(publicOrigin);
  const signalURL = new URL(livekitUrl);
  const upstreamURL = new URL(livekitHttpUrl);
  const devOrigin = options.dev && originURL.protocol === 'http:' && loopback(originURL.hostname.replace(/^\[|\]$/g, ''));
  if ((!devOrigin && originURL.protocol !== 'https:') || originURL.origin !== publicOrigin || originURL.username || originURL.password) throw Error('Public origin must be an HTTPS origin (explicit loopback development only)');
  if (signalURL.protocol !== 'wss:' && !(devOrigin && signalURL.protocol === 'ws:' && loopback(signalURL.hostname.replace(/^\[|\]$/g, '')))) throw Error('LiveKit URL must use WSS');
  if (signalURL.username || signalURL.password || signalURL.search || signalURL.hash || signalURL.pathname !== '/livekit' || signalURL.host !== originURL.host) throw Error('LiveKit WSS URL must be public origin + /livekit');
  if (upstreamURL.protocol !== 'http:' || !loopback(upstreamURL.hostname.replace(/^\[|\]$/g, '')) || upstreamURL.username || upstreamURL.password || upstreamURL.pathname !== '/' || upstreamURL.search || upstreamURL.hash) throw Error('LiveKit API must be loopback HTTP');
  if (typeof ownerKey !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(ownerKey)) throw Error('Owner key must contain at least 32 random bytes, encoded as hex/base64url');
  if (typeof apiKey !== 'string' || !apiKey || typeof apiSecret !== 'string' || apiSecret.length < 32) throw Error('LiveKit key and 32-byte secret required');
  const publicDir = resolve(options.publicDir ?? fileURLToPath(new URL('../public', import.meta.url)));
  const staticFiles = new Set(['/index.html', '/styles.css', '/styles.js', '/viewer.js', '/webrtc.js', '/relay.js', '/vendor/livekit-client.js', '/vendor/livekit-client.esm.js']);
  const securityHeaders = {
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' wss: https:; media-src 'self' blob:; img-src 'self' data:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'X-Frame-Options': 'DENY',
    ...(devOrigin ? {} : { 'Strict-Transport-Security': 'max-age=31536000' }),
  };
  const roomService = options.roomService ?? new RoomServiceClient(livekitHttpUrl, apiKey, apiSecret, { requestTimeout: 5 });
  const verifier = new TokenVerifier(apiKey, apiSecret);
  const signalSockets = new Set();
  const ownerHash = hash(`Bearer ${ownerKey}`);
  const now = options.now ?? Date.now;
  const maxSessionMs = options.maxSessionMs ?? 12 * 60 * 60 * 1000;
  const budget = limiter(options.rateLimit, now);
  let active = null, pendingDelete = null;
  let queue = Promise.resolve();
  const serial = fn => { const next = queue.then(fn); queue = next.catch(() => {}); return next; };
  async function revoke() {
    if (active) { pendingDelete = active.room; active = null; }
    for (const socket of signalSockets) socket.destroy();
    signalSockets.clear();
    if (pendingDelete) {
      try { await roomService.deleteRoom(pendingDelete); }
      catch (error) { if (error.code !== 'not_found' && error.status !== 404) throw error; }
      pendingDelete = null;
    }
  }
  async function expire() { if (pendingDelete || (active && now() >= active.expires)) await revoke(); }
  const sweep = () => serial(expire);
  const timer = setInterval(() => { sweep().catch(() => {}); }, 1000);
  timer.unref();
  async function token(identity, publish) {
    const access = new AccessToken(apiKey, apiSecret, { identity, ttl: 300 });
    access.addGrant({ room: active.room, roomJoin: true, canPublish: publish, canSubscribe: !publish,
      canPublishData: false, roomCreate: false, roomAdmin: false, canUpdateOwnMetadata: false });
    return access.toJwt();
  }
  function clientIP(req) {
    const remote = req.socket.remoteAddress;
    const forwarded = req.headers['x-forwarded-for'];
    return options.trustLoopbackProxy && loopback(remote) && typeof forwarded === 'string' && isIP(forwarded) ? forwarded : remote;
  }
  const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 10000, connectionsCheckingInterval: 1000 }, async (req, res) => {
    for (const [name, value] of Object.entries(securityHeaders)) res.setHeader(name, value);
    const send = (status, body) => {
      if (res.destroyed || res.writableEnded) return;
      if (status >= 400) res.setHeader('Connection', 'close');
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    try {
      const path = req.url.split('?')[0];
      if (['/livekit/rtc/validate', '/livekit/rtc/v1/validate'].includes(path) && req.method === 'GET') return await signaling.http(req, res);
      if (path.startsWith('/api/') && req.url.includes('?')) return send(400, { error: 'Query parameters forbidden' });
      if (req.method === 'GET' && path === '/health') return send(200, { ok: true });
      if (req.method === 'GET' && path === '/api/info') return send(200, { mode: 'relay' });
      if (path === '/api/session') {
        const origin = req.headers.origin;
        if (origin !== undefined && !electronOrigin(origin)) return send(403, { error: 'Origin forbidden' });
        if (origin) {
          res.setHeader('Access-Control-Allow-Origin', origin);
          res.setHeader('Vary', 'Origin');
        }
        if (req.method === 'OPTIONS') {
          if (!origin || !['POST', 'DELETE'].includes(req.headers['access-control-request-method'])) return send(403, { error: 'Preflight forbidden' });
          const headers = (req.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
          if (headers.some(h => !['authorization', 'content-type'].includes(h))) return send(403, { error: 'Preflight forbidden' });
          res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE');
          res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
          return send(204);
        }
        if (!['POST', 'DELETE'].includes(req.method)) return send(405, { error: 'Method not allowed' });
        if (!budget(clientIP(req))) { res.setHeader('Retry-After', '60'); return send(429, { error: 'Too many attempts' }); }
        if (!timingSafeEqual(hash(req.headers.authorization ?? ''), ownerHash)) return send(401, { error: 'Unauthorized' });
        if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0) > 0) return send(400, { error: 'Session request must have no body' });
        return await serial(async () => {
          await revoke();
          if (req.method === 'DELETE') return send(204);
          const room = `chdss-${randomBytes(18).toString('hex')}`;
          const password = randomBytes(24).toString('base64url');
          pendingDelete = room; // A failed request may still have created the room upstream.
          await roomService.createRoom({ name: room, maxParticipants: 13, emptyTimeout: 300, departureTimeout: 30 });
          pendingDelete = null;
          active = { room, passwordHash: hash(password), expires: now() + maxSessionMs, admissions: new Map() };
          return send(200, { url: livekitUrl, room, password, token: await token('host', true), viewerUrl: publicOrigin });
        });
      }
      if (path === '/api/join' && req.method === 'POST') {
        if (req.headers.origin !== publicOrigin) return send(403, { error: 'Origin forbidden' });
        if (!budget(clientIP(req))) { res.setHeader('Retry-After', '60'); return send(429, { error: 'Too many attempts' }); }
        const body = await jsonBody(req, options.bodyTimeoutMs ?? 5000);
        return await serial(async () => {
          if (active && now() >= active.expires) await revoke().catch(() => {});
          const candidate = hash(typeof body.password === 'string' ? body.password : '');
          const valid = timingSafeEqual(candidate, active?.passwordHash ?? hash(''));
          if (!active || typeof body.password !== 'string' || !valid) return send(401, { error: 'Invalid password or no active session' });
          const participants = await roomService.listParticipants(active.room);
          const connected = new Set(participants.filter(p => p.identity !== 'host').map(p => p.identity));
          for (const [identity, expiry] of active.admissions) if (expiry <= now() && !connected.has(identity)) active.admissions.delete(identity);
          const reserved = new Set([...connected, ...active.admissions.keys()]);
          if (reserved.size >= 12) return send(409, { error: 'Viewer limit reached' });
          const identity = `viewer-${randomBytes(12).toString('hex')}`;
          active.admissions.set(identity, now() + 300000);
          return send(200, { url: livekitUrl, room: active.room, token: await token(identity, false) });
        });
      }
      const asset = path === '/' ? '/index.html' : path;
      if (['GET', 'HEAD'].includes(req.method) && staticFiles.has(asset)) {
        try {
          const root = await realpath(publicDir);
          const file = resolve(root, '.' + asset);
          if (await realpath(file) !== file) return send(404, { error: 'Not found' });
          const content = await readFile(file);
          const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(file)];
          res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Content-Length': content.length });
          return res.end(req.method === 'HEAD' ? undefined : content);
        } catch { return send(404, { error: 'Not found' }); }
      }
      send(404, { error: 'Not found' });
    } catch (error) { send([400, 408, 413, 415].includes(error.status) ? error.status : 503, { error: [400, 408, 413, 415].includes(error.status) ? error.message : 'Relay unavailable' }); }
  });
  server.maxConnections = 256;
  server.maxRequestsPerSocket = 100;
  server.keepAliveTimeout = 5000;
  const signaling = attachSignalingProxy(server, {
    upstream: livekitHttpUrl, sockets: signalSockets,
    async authorize(req) {
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== publicOrigin && !electronOrigin(origin)) throw fail(403, 'Origin forbidden');
      if (!signalBudget(clientIP(req))) throw fail(429, 'Too many attempts');
      const url = new URL(req.url, publicOrigin);
      const jwt = url.searchParams.get('access_token') ?? req.headers.authorization?.replace(/^Bearer /, '');
      let grant;
      try { grant = await verifier.verify(jwt ?? '', 0); } catch { throw fail(401, 'Unauthorized'); }
      if (!active || active.expires <= now() || grant.video?.room !== active.room || !grant.video.roomJoin || (grant.sub !== 'host' && !active.admissions.has(grant.sub))) throw fail(401, 'Session expired');
      return origin;
    },
  });
  const signalBudget = limiter({ perIp: 120, global: 1200, maxIps: 4096 }, now);
  return { server, sweep, async initialize() {
    const rooms = await roomService.listRooms();
    for (const room of rooms) if (room.name.startsWith('chdss-')) await roomService.deleteRoom(room.name);
  }, async close() {
    clearInterval(timer);
    try { await serial(revoke); } finally { await new Promise(resolve => server.close(resolve)); }
  } };
}
