import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('Debian bundle generates isolated, TLS-only configuration without installing host packages', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'chdss-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  execFileSync(process.execPath, ['server/configure.js', dir, 'stream.example.com', process.cwd()]);
  const config = JSON.parse(await readFile(join(dir, 'secrets.json'), 'utf8'));
  assert.match(config.ownerKey, /^[a-f0-9]{64}$/);
  assert.equal(config.publicOrigin, 'https://stream.example.com');
  assert.equal(config.livekitUrl, 'wss://stream.example.com/livekit');
  const compose = await readFile(join(dir, 'compose.yml'), 'utf8');
  const caddy = await readFile(join(dir, 'Caddyfile'), 'utf8');
  assert.match(compose, /network_mode: host/);
  assert.match(caddy, /127\.0\.0\.1:41800/);
  assert.doesNotMatch(compose, new RegExp(config.ownerKey));
  execFileSync(process.execPath, ['server/configure.js', dir, 'stream.example.com', process.cwd()]);
  assert.equal(JSON.parse(await readFile(join(dir, 'secrets.json'), 'utf8')).ownerKey, config.ownerKey);
  assert.throws(() => execFileSync(process.execPath, ['server/configure.js', dir, 'bad;hostname', process.cwd()], { stdio: 'pipe' }));
});
