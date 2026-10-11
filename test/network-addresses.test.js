import test from 'node:test';
import assert from 'node:assert/strict';
import { viewerAddresses } from '../src/network-addresses.js';

const ipv4 = address => ({ address, family: 'IPv4', internal: false });
test('viewer addresses retain every adapter name and IPv4 alias, including ZeroTier', () => {
  const addresses = viewerAddresses({ Ethernet: [ipv4('192.168.1.20'), ipv4('192.168.1.21')], 'ZeroTier One': [ipv4('10.147.17.2')], lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] }, 41730, 'private-token');
  assert.deepEqual(addresses.map(({ adapter, address }) => [adapter, address]), [['Ethernet', '192.168.1.20'], ['Ethernet', '192.168.1.21'], ['ZeroTier One', '10.147.17.2']]);
  assert.equal(addresses[2].url, 'http://10.147.17.2:41730/#private-token');
  assert.ok(addresses.every(entry => new URL(entry.url).hash === '#private-token'));
});

test('viewer addresses accept routable IPv6, omit unusable scoped addresses and duplicates', () => {
  const addresses = viewerAddresses({ en0: [ipv4('192.168.1.20'), ipv4('192.168.1.20'), { address: 'fd12::5', family: 'IPv6', internal: false }, { address: 'fe80::1', family: 'IPv6', internal: false }, { address: 'fe80::1%en0', family: 'IPv6', internal: false }, ipv4('not-an-ip')] }, 12345, 'abc');
  assert.equal(addresses.length, 2);
  assert.equal(addresses[1].url, 'http://[fd12::5]:12345/#abc');
});

test('network inventory is recomputed and loopback is a clearly labelled last resort', () => {
  const first = viewerAddresses({}, 41730, 'abc');
  assert.deepEqual(first, [{ adapter: 'Local only', address: '127.0.0.1', family: 'IPv4', url: 'http://127.0.0.1:41730/#abc' }]);
  assert.equal(viewerAddresses({ zt0: [ipv4('10.1.1.1')] }, 41730, 'abc')[0].adapter, 'zt0');
});
