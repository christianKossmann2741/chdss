import { mkdir, readFile, writeFile, chmod, chown } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';

const [directory, domain, project] = process.argv.slice(2);
if (!directory || !project || !domain || domain.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
  throw new Error('Use a real DNS hostname, e.g. stream.example.com (no URL, path or shell punctuation).');
}
const dir = resolve(directory);
await mkdir(dir, { recursive: true, mode: 0o700 });
await chmod(dir, 0o700);
const secretsPath = join(dir, 'secrets.json');
let secrets;
try { secrets = JSON.parse(await readFile(secretsPath, 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  secrets = { ownerKey: randomBytes(32).toString('hex'), apiKey: `CHDSS${randomBytes(12).toString('hex')}`, apiSecret: randomBytes(48).toString('hex') };
}
if (secrets.publicOrigin && secrets.publicOrigin !== `https://${domain}`) throw new Error('This data directory belongs to another domain. Use a separate CHDSS_DATA directory.');
Object.assign(secrets, { publicOrigin: `https://${domain}`, livekitUrl: `wss://${domain}/livekit`, livekitHttpUrl: 'http://127.0.0.1:7880', trustLoopbackProxy: true });
await writeFile(secretsPath, JSON.stringify(secrets), { mode: 0o600 });
if (process.getuid?.() === 0) await chown(secretsPath, 1000, 1000);
const json = JSON.stringify;
await writeFile(join(dir, 'livekit.yml'), `port: 7880
bind_addresses: [127.0.0.1]
rtc:
  tcp_port: 7881
  udp_port: 7882
  use_external_ip: true
keys:
  ${secrets.apiKey}: ${secrets.apiSecret}
turn:
  enabled: true
  udp_port: 3478
logging:
  level: error
`, { mode: 0o600 });
await writeFile(join(dir, 'Caddyfile'), `{
  log default {
    level FATAL
  }
}
${domain} {
  encode zstd gzip
  reverse_proxy 127.0.0.1:41800 {
    header_up X-Forwarded-For {remote_host}
  }
}
`, { mode: 0o600 });
await writeFile(join(dir, 'compose.yml'), `name: chdss
services:
  livekit:
    image: livekit/livekit-server:v1.13.6
    command: ["--config", "/etc/livekit.yml"]
    network_mode: host
    restart: unless-stopped
    volumes:
      - ${json(join(dir, 'livekit.yml') + ':/etc/livekit.yml:ro')}
    security_opt: ["no-new-privileges:true"]
    cap_drop: [ALL]
    mem_limit: 1g
    pids_limit: 256
  relay:
    build:
      context: ${json(resolve(project))}
      dockerfile: server/Dockerfile
    network_mode: host
    restart: unless-stopped
    user: "1000:1000"
    read_only: true
    security_opt: ["no-new-privileges:true"]
    cap_drop: [ALL]
    mem_limit: 256m
    pids_limit: 64
    volumes:
      - ${json(secretsPath + ':/run/chdss.json:ro')}
    depends_on: [livekit]
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:41800/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 6
  caddy:
    image: caddy:2.11.4-alpine
    network_mode: host
    restart: unless-stopped
    security_opt: ["no-new-privileges:true"]
    volumes:
      - ${json(join(dir, 'Caddyfile') + ':/etc/caddy/Caddyfile:ro')}
      - caddy_data:/data
      - caddy_config:/config
    depends_on: [relay]
    mem_limit: 256m
    pids_limit: 128
volumes:
  caddy_data:
  caddy_config:
`, { mode: 0o600 });
console.log('CHDSS configuration ready. Secrets are stored only in the private data directory.');
