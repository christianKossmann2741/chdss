import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const read = name => fs.readFileSync(path.join(root, 'native/windows', name), 'utf8');
test('native process capture uses include-tree activation with float48 stereo and lifecycle contract', () => {
  assert.ok(fs.existsSync(path.join(root, 'native/windows/main.cpp')), 'real Windows helper implementation missing');
  const code = read('main.cpp');
  assert.match(code, /ActivateAudioInterfaceAsync/);
  assert.match(code, /PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE/);
  assert.doesNotMatch(code, /PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE/);
  assert.match(code, /WAVE_FORMAT_IEEE_FLOAT/);
  assert.match(code, /48000/);
  assert.match(code, /AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM/);
  assert.match(code, /GetWindowThreadProcessId/);
  assert.match(code, /IAudioSessionManager2/);
  assert.match(code, /SetConsoleCtrlHandler/);
  assert.match(code, /CancelSynchronousIo/);
  assert.match(code, /\{\\"type\\":\\"ready\\"/);
  assert.match(code, /\{\\"type\\":\\"error\\"/);
  assert.match(code, /20348/);
});
test('cleanup cannot hide runtime errors as a requested shutdown', () => {
  const code = read('main.cpp');
  assert.match(code, /shutdown_requested/);
  assert.doesNotMatch(code, /bool requested = stopping\(\)/);
  assert.match(code, /InputThread input;\s*run_capture\(source\)/, 'stdin EOF must be observed during activation, not just afterward');
});
test('self-contained target build has static runtime and exact output path', () => {
  assert.ok(fs.existsSync(path.join(root, 'native/windows/CMakeLists.txt')), 'native build missing');
  const build = read('CMakeLists.txt');
  assert.match(build, /win32-x64/);
  assert.match(build, /chdss-audio/);
  assert.match(build, /MSVC_RUNTIME_LIBRARY/);
  assert.match(build, /-static/);
});
