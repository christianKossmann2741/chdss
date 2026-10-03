import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

async function text(name) { return readFile(join(root, name), 'utf8'); }

test('macOS installer is valid Bash and creates the chdss launcher', async () => {
  const path = join(root, 'install.sh');
  assert.equal(spawnSync('bash', ['-n', path]).status, 0);
  const source = await text('install.sh');
  assert.match(source, /CHDSS_HOME/);
  assert.match(source, /CHDSS_BIN_DIR/);
  assert.match(source, /npm (ci|install)/);
  assert.match(source, /bin\/chdss/);
});

test('Windows installer checks prerequisites and installs a user PATH command', async () => {
  const source = await text('install.ps1');
  assert.match(source, /Get-Command node/);
  assert.match(source, /Get-Command npm/);
  assert.match(source, /EnvironmentVariableTarget.*User/);
  assert.match(source, /chdss\.cmd/);
  assert.match(source, /npm\.cmd.*(?:ci|install)/s);
});

test('both uninstallers exist and only remove CHDSS-owned paths', async () => {
  for (const name of ['uninstall.sh', 'uninstall.ps1']) await stat(join(root, name));
  assert.match(await text('uninstall.sh'), /CHDSS_HOME/);
  assert.match(await text('uninstall.ps1'), /CHDSS/);
});

test('source installers include and compile native audio before replacing an installed app', async () => {
  for (const name of ['install.sh', 'install.ps1']) {
    const source = await text(name);
    assert.match(source, /native/);
    assert.match(source, /build-native\.js/);
  }
});
