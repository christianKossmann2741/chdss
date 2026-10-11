import { isIP } from 'node:net';
import { publicViewerUrl } from './config.js';

export function viewerAddresses(interfaces, port, token) {
  const addresses = [];
  const seen = new Set();
  for (const [adapter, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      const family = isIP(entry.address);
      // Scoped IPv6 cannot be expressed as a portable browser viewer URL.
      if (entry.internal || !family || (family === 6 && /^fe[89ab]/i.test(entry.address))) continue;
      const key = `${adapter}\0${entry.address}`;
      if (seen.has(key)) continue;
      seen.add(key);
      addresses.push({ adapter, address: entry.address, family: `IPv${family}`, url: publicViewerUrl(entry.address, port, token) });
    }
  }
  // Preserve OS adapter ordering, preferring IPv4 for the initial selection.
  addresses.sort((a, b) => a.family.localeCompare(b.family));
  if (!addresses.length) addresses.push({ adapter: 'Local only', address: '127.0.0.1', family: 'IPv4', url: publicViewerUrl('127.0.0.1', port, token) });
  return addresses;
}
