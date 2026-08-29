import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = name => readFile(join(root, name), 'utf8');

test('viewer reveals video on track and supports browser Picture-in-Picture', async () => {
  const [script, css] = await Promise.all([read('public/viewer.js'), read('public/styles.css')]);
  assert.match(script, /classList\.add\(['"]receiving['"]\)/);
  assert.match(script, /classList\.remove\(['"]receiving['"]\)/);
  assert.match(script, /requestPictureInPicture/);
  assert.match(css, /video:not\(\.receiving\)/);
});

test('host requests explicit audio constraints and refuses silent capture', async () => {
  const [script, main, preload, markup] = await Promise.all([
    read('public/host.js'), read('src/main.js'), read('src/preload.cjs'), read('public/host.html')
  ]);
  assert.match(script, /audio:\s*audioConstraints\(\)/);
  assert.match(script, /if \(!audioTrack\)/);
  assert.match(script, /selectSource/);
  assert.match(main, /useSystemPicker:\s*false/);
  assert.match(main, /chdss:sources/);
  assert.match(main, /audio:\s*'loopback'/);
  assert.match(preload, /selectSource/);
  assert.match(markup, /id="source"/);
});
