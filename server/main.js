import { readFile } from 'node:fs/promises';
import { createRelayServer } from './relay.js';

const config = JSON.parse(await readFile(process.env.CHDSS_CONFIG ?? '/run/chdss.json', 'utf8'));
const app = createRelayServer(config);
let ready = false;
for (let attempt = 0; attempt < 15; attempt++) {
  try { await app.initialize(); ready = true; break; }
  catch { await new Promise(resolve => setTimeout(resolve, 2000)); }
}
if (!ready) { console.error('CHDSS: media server unavailable; refusing to open authentication service.'); process.exit(1); }
await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(41800, '127.0.0.1', resolve); });
console.log('CHDSS relay ready on loopback port 41800. Use the HTTPS viewer origin.');
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 10000);
  deadline.unref();
  try { await app.close(); process.exit(0); }
  catch { console.error('CHDSS: failed to confirm media room cleanup during shutdown.'); process.exit(1); }
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
