import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = name => readFile(new URL(`../${name}`, import.meta.url), 'utf8');

test('desktop exposes native menus, sandbox and guarded IPC', async () => {
  const main = await read('src/main.js');
  assert.match(main, /Menu\.setApplicationMenu/);
  assert.match(main, /sandbox: true/);
  assert.match(main, /senderFrame/);
  assert.match(main, /setWindowOpenHandler/);
  assert.match(main, /powerSaveBlocker/);
  assert.match(main, /dialog\.showMessageBox/);
  assert.match(main, /titleBarStyle:.*hiddenInset/);
});
