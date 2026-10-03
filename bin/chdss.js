#!/usr/bin/env node
import { spawn } from 'node:child_process';
import electron from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log("Christian's Handy Dandy Screen Share\n\nUsage: chdss\n\nStarts the LAN screen-share console. Set CHDSS_PORT to override port 41730.");
  process.exit(0);
}
if (process.argv.includes('--version') || process.argv.includes('-v')) {
  console.log(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version);
  process.exit(0);
}
const child = spawn(electron, [root, ...process.argv.slice(2)], { detached: true, stdio: 'ignore', env: process.env });
child.unref();
