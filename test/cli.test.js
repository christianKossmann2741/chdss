import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'chdss.js');

test('chdss --help explains launch and port override without starting Electron', () => {
  const result = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Christian's Handy Dandy Screen Share/);
  assert.match(result.stdout, /CHDSS_PORT/);
});

test('chdss --version prints package version', () => {
  const result = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), JSON.parse(readFileSync(join(dirname(cli), '..', 'package.json'), 'utf8')).version);
});
