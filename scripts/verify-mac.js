import { _electron as electron, chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const output = process.env.CHDSS_SCREENSHOTS ?? '/tmp/chdss-v2-screens';
await mkdir(output, { recursive: true });
const app = await electron.launch({ executablePath: resolve('dist/mac-arm64/CHDSS.app/Contents/MacOS/CHDSS'), env: { ...process.env, CHDSS_PORT: '41735' } });
let browser;
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => document.getElementById('source')?.options.length || !document.getElementById('errorNotice')?.classList.contains('hidden'));
  const state = await page.evaluate(async () => {
    const details = await window.chdss.details();
    return { version: details.version, platform: details.platform, permission: details.screenPermission, sources: document.getElementById('source').options.length, error: document.getElementById('errorNotice').textContent };
  });
  console.log('Packaged desktop:', JSON.stringify(state));
  assert.equal(state.version, JSON.parse(await readFile('package.json', 'utf8')).version);
  const health = await fetch('http://127.0.0.1:41735/health').then(r => r.json());
  assert.equal(health.broadcaster, true);
  await page.screenshot({ path: `${output}/mac-packaged.png`, fullPage: true });
  await page.click('#modeInternet');
  await page.screenshot({ path: `${output}/mac-internet.png`, fullPage: true });
  await page.click('#modeLan');
  if (state.permission === 'granted' && state.sources) {
    const id = await page.locator('#source option').evaluateAll(options => options.find(option => option.value.startsWith('screen:'))?.value);
    if (id) await page.selectOption('#source', id);
    await page.uncheck('#includeAudio');
    await page.click('#shareButton');
    await page.waitForFunction(() => document.getElementById('preview').videoWidth > 0 || !document.getElementById('errorNotice').classList.contains('hidden'));
    const capture = await page.evaluate(() => ({ width: document.getElementById('preview').videoWidth, error: document.getElementById('errorNotice').textContent }));
    console.log('Native video capture:', JSON.stringify(capture));
    assert.ok(capture.width > 0, capture.error);
    browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
    const viewer = await browser.newPage();
    const invite = await page.inputValue('#viewerUrl');
    await viewer.goto(invite.replace(new URL(invite).hostname, '127.0.0.1'));
    await viewer.waitForFunction(() => document.getElementById('stream').videoWidth > 0);
    console.log('PASS: packaged Mac native screen capture reaches browser viewer');
    await page.click('#stopButton');
  } else console.log('Native capture needs user permission; package startup/UI verified only.');
} finally {
  await browser?.close();
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
}
