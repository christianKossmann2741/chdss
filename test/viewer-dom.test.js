import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const read = path => readFile(new URL(`../public/${path}`, import.meta.url), 'utf8');
test('studio retains capture contract and adds explicit audio and private-session controls', async () => {
  const html = await read('host.html');
  const ids = ['source','quality','frameRate','bitrate','shareButton','stopButton','preview','previewEmpty','liveBadge','viewerCount','audioStatus','audioMeter','errorNotice','permissionNotice','permissions','viewerUrl','copyUrl','refreshSources','preset','includeAudio','muteAudio','elapsed','streamStats','sourceSummary','modeLan','modeInternet','lanPanel','internetPanel','serverUrl','publisherKey','remoteConnect','remoteDisconnect','remoteStatus','remoteViewerUrl','streamPassword','revealPassword','copyInvite','remoteInvite'];
  for (const id of ids) assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, id);
  assert.match(html, /id="includeAudio"[^>]*checked/);
  for (const preset of ['balanced','motion','detail','economy']) assert.match(html, new RegExp(`value="${preset}"`));
  assert.match(html, /LAN stays available/);
  assert.match(html, /src="\.\/host.js"/);
  assert.doesNotMatch(html, /https?:\/\/.*(?:cdn|fonts.googleapis)/);
});
test('viewer has password form and accessible media controls without built-in duplicate controls', async () => {
  const html = await read('index.html');
  for (const id of ['joinForm','joinPassword','joinButton','joinError','unlockPanel','muteButton','volume','logoutButton','retryButton','emptyTitle','emptyMessage']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /id="joinPassword"[^>]*type="password"/);
  assert.doesNotMatch(html, /<video[^>]*\scontrols/);
});
