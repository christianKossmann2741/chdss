import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createShareServer } from '../src/server.js';
import { mkdir } from 'node:fs/promises';

const share = await createShareServer({ port: 0, token: 'viewer-fixture', hostToken: 'host-fixture', host: '127.0.0.1' });
const browser = await chromium.launch();
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1160, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.networkFixture = [
      { adapter: 'Ethernet', address: '192.168.1.20', family: 'IPv4', url: 'http://192.168.1.20:41730/#viewer-fixture' },
      { adapter: 'ZeroTier One', address: '10.147.17.2', family: 'IPv4', url: 'http://10.147.17.2:41730/#viewer-fixture' },
      { adapter: 'Virtual IPv6', address: 'fd12::5', family: 'IPv6', url: 'http://[fd12::5]:41730/#viewer-fixture' }
    ];
    window.chdss = {
      details: async () => ({ hostToken: 'host-fixture', networkAddresses: window.networkFixture, viewerUrls: window.networkFixture.map(entry => entry.url), platform: 'darwin', screenPermission: 'granted' }),
      sources: async () => [{ id: 'screen:0:0', name: 'Test screen' }],
      selectSource: async () => {}, setSharing: async () => {}, onCommand: () => {},
      copy: async text => { window.copiedFixture = text; }, openPermissions: async () => {},
      stopAudio: async () => {}, onAudio: () => () => {}, onAudioFailure: () => () => {}
    };
  });
  await page.goto(share.localUrl + '/host.html');
  await page.waitForFunction(() => !document.getElementById('shareButton').disabled);
  assert.equal(await page.locator('#networkAdapter option').count(), 3);
  assert.match(await page.locator('#networkAdapter').textContent(), /10\.147\.17\.2.*ZeroTier One/);
  const zerotier = await page.locator('#networkAdapter option').evaluateAll(options => options.find(option => option.textContent.includes('ZeroTier')).value);
  await page.selectOption('#networkAdapter', zerotier);
  assert.equal(await page.inputValue('#viewerUrl'), 'http://10.147.17.2:41730/#viewer-fixture');
  await page.click('#copyUrl');
  await page.waitForFunction(() => window.copiedFixture === 'http://10.147.17.2:41730/#viewer-fixture');
  await page.evaluate(() => { window.networkFixture.reverse(); });
  await page.click('#refreshNetworks');
  await page.waitForFunction(() => !document.getElementById('refreshNetworks').disabled);
  assert.equal(await page.inputValue('#viewerUrl'), 'http://10.147.17.2:41730/#viewer-fixture');
  const directory = process.env.CHDSS_SCREENSHOTS ?? '/tmp/chdss-network-screens';
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: directory + '/network-selector.png', fullPage: true });
  await page.evaluate(() => { window.networkFixture = window.networkFixture.filter(entry => !entry.adapter.includes('ZeroTier')); });
  await page.click('#refreshNetworks');
  await page.waitForFunction(() => !document.getElementById('refreshNetworks').disabled);
  assert.notEqual(await page.inputValue('#viewerUrl'), 'http://10.147.17.2:41730/#viewer-fixture');
  await page.selectOption('#networkAdapter', { label: 'fd12::5 · Virtual IPv6' });
  assert.equal(await page.inputValue('#viewerUrl'), 'http://[fd12::5]:41730/#viewer-fixture');
  await page.click('#copyUrl');
  await page.waitForFunction(() => window.copiedFixture === 'http://[fd12::5]:41730/#viewer-fixture');
  assert.deepEqual(errors, []);
  console.log('PASS: adapter labels, ZeroTier selection/copy, refresh preservation/removal, IPv6 URL and no browser errors.');
} finally { await browser.close(); await share.close(); }
