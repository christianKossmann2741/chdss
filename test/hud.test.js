import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FlapBoard, Sparkline, Ticker, Waveform, formatBitrate, groupDigits, scramble, timecode, typewriter } from '../public/hud.js';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('HUD formatters render broadcast clocks, counters and rates', () => {
  assert.equal(timecode(0), '00:00:00');
  assert.equal(timecode(3725.9), '01:02:05');
  assert.equal(timecode(-4), '00:00:00');
  assert.equal(groupDigits(1323714), '1,323,714');
  assert.equal(groupDigits(42.4), '42');
  assert.equal(formatBitrate(8_000_000), '8.0 Mbps');
  assert.equal(formatBitrate(640_000), '640 kbps');
  assert.equal(formatBitrate(Number.NaN), '0 kbps');
});

test('HUD effects degrade to plain text without an animation clock or DOM', () => {
  const element = { textContent: 'old', classList: { add() {} } };
  scramble(element, 'Locked');
  assert.equal(element.textContent, 'Locked');
  typewriter(element, 'Select a source');
  assert.equal(element.textContent, 'Select a source');
  const flaps = new FlapBoard({ textContent: '' }, { length: 2 });
  flaps.set(7);
  assert.equal(flaps.element.textContent, '07');
  flaps.set(123);
  assert.equal(flaps.element.textContent, '23');
  assert.doesNotThrow(() => { new Waveform({}).push(2); new Ticker({}).set([['A', 'b']]); new Sparkline({}).push(5); });
});

test('interface fonts are bundled offline and never fetched from a third party', async () => {
  const [css, build, dockerfile, packager, relay, server] = await Promise.all([read('public/styles.css'), read('scripts/build-web.js'), read('server/Dockerfile'), read('scripts/package-server.js'), read('server/relay.js'), read('src/server.js')]);
  const sources = [...css.matchAll(/url\("([^"]+)"\)/g)].map(match => match[1]).filter(url => !url.startsWith('data:'));
  assert.ok(sources.length >= 5);
  for (const url of sources) assert.match(url, /^\.\/vendor\/fonts\/[a-z0-9-]+\.woff2$/);
  assert.doesNotMatch(css.replace(/url\("data:[^"]+"\)/g, ''), /@import|https?:\/\//);
  for (const url of sources) assert.match(build, new RegExp(url.split('/').pop().replace('.', '\\.')));
  assert.match(build, /LICENSE-/);
  assert.match(dockerfile, /public\/hud\.js/);
  assert.match(packager, /'hud\.js'/);
  assert.match(relay, /font-src 'self'/);
  assert.match(server, /font-src 'self'/);
});

test('animations respect reduced motion', async () => {
  const css = await read('public/styles.css');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});
