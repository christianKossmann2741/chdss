import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = name => readFile(join(root, name), 'utf8');

test('Windows packaging produces a self-contained portable executable', async () => {
  const [manifestText, workflow, releaseWorkflow] = await Promise.all([
    read('package.json'),
    read('.github/workflows/ci.yml'),
    read('.github/workflows/release.yml')
  ]);
  const manifest = JSON.parse(manifestText);

  assert.equal(manifest.scripts['dist:win'], 'electron-builder --win portable --x64');
  assert.equal(manifest.build.win.target, 'portable');
  assert.equal(manifest.build.artifactName, 'CHDSS-${version}-Windows-Portable.${ext}');
  assert.equal(manifest.build.asar, true);
  assert.match(workflow, /npm run dist:win/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /dist\/\*\.exe/);
  assert.match(releaseWorkflow, /npm run dist:win/);
  assert.match(releaseWorkflow, /npm run dist:mac/);
  assert.match(releaseWorkflow, /ditto -c -k --sequesterRsrc --keepParent/);
  assert.match(releaseWorkflow, /actions\/upload-artifact/);
  assert.match(releaseWorkflow, /actions\/download-artifact/);
  assert.match(releaseWorkflow, /gh release create/);
  assert.match(releaseWorkflow, /--repo "\$GITHUB_REPOSITORY"/);
});

test('macOS packaging produces a self-contained Apple Silicon application', async () => {
  const manifest = JSON.parse(await read('package.json'));

  assert.equal(manifest.scripts['dist:mac'], 'electron-builder --mac dir --arm64');
  assert.equal(manifest.build.mac.target, 'dir');
  assert.equal(manifest.build.mac.category, 'public.app-category.utilities');
  assert.match(manifest.build.mac.extendInfo.NSAudioCaptureUsageDescription, /system audio/i);
  assert.match(manifest.build.mac.extendInfo.NSScreenCaptureUsageDescription, /screen/i);
});
