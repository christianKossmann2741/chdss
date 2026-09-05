import { build } from 'esbuild';
await build({ entryPoints: ['livekit-client'], bundle: true, format: 'esm', platform: 'browser', target: ['chrome120', 'safari17'], minify: true, outfile: 'public/vendor/livekit-client.js', legalComments: 'linked' });
console.log('Bundled offline LiveKit browser SDK.');
