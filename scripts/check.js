import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

let count = 0;
for (const directory of ['src', 'public', 'server', 'scripts']) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.(?:js|cjs)$/.test(entry.name)) continue;
    const result = spawnSync(process.execPath, ['--check', `${directory}/${entry.name}`], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status ?? 1);
    count++;
  }
}
console.log(`Syntax checks passed for ${count} JavaScript files.`);
