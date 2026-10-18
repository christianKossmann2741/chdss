import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

await build({ entryPoints: ['livekit-client'], bundle: true, format: 'esm', platform: 'browser', target: ['chrome120', 'safari17'], minify: true, outfile: 'public/vendor/livekit-client.js', legalComments: 'linked' });
console.log('Bundled offline LiveKit browser SDK.');

// Fonts are served from the app/relay origin: no third-party font CDN sees viewers.
const fonts = {
  'plex-mono-400.woff2': '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2',
  'plex-mono-500.woff2': '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2',
  'plex-mono-600.woff2': '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-600-normal.woff2',
  'inter-tight-500.woff2': '@fontsource/inter-tight/files/inter-tight-latin-500-normal.woff2',
  'inter-tight-700.woff2': '@fontsource/inter-tight/files/inter-tight-latin-700-normal.woff2',
  'instrument-serif-400.woff2': '@fontsource/instrument-serif/files/instrument-serif-latin-400-normal.woff2',
  'instrument-serif-400-italic.woff2': '@fontsource/instrument-serif/files/instrument-serif-latin-400-italic.woff2'
};
await mkdir('public/vendor/fonts', { recursive: true });
for (const [name, source] of Object.entries(fonts)) await copyFile(`node_modules/${source}`, `public/vendor/fonts/${name}`);
for (const family of ['ibm-plex-mono', 'inter-tight', 'instrument-serif']) await copyFile(`node_modules/@fontsource/${family}/LICENSE`, `public/vendor/fonts/LICENSE-${family}.txt`);
console.log('Copied offline interface fonts.');
