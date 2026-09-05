import { cp, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const temp = await mkdtemp(join(tmpdir(), 'chdss-package-'));
const name = `CHDSS-${version}-Debian-Server`;
const root = join(temp, name);
try {
  await mkdir(join(root, 'server'), { recursive: true });
  await mkdir(join(root, 'public/vendor'), { recursive: true });
  for (const entry of await readdir('server', { withFileTypes: true })) {
    if (entry.isFile() && /(?:\.js|\.json|\.md|\.sh|Dockerfile)$/.test(entry.name)) await cp(join('server', entry.name), join(root, 'server', entry.name));
  }
  for (const name of ['index.html', 'viewer.js', 'styles.css', 'webrtc.js']) await cp(join('public', name), join(root, 'public', name));
  await cp('public/vendor', join(root, 'public/vendor'), { recursive: true });
  await cp('LICENSE', join(root, 'LICENSE'));
  await cp('.dockerignore', join(root, '.dockerignore'));
  await mkdir('dist', { recursive: true });
  const archive = resolve(`dist/${name}.tar.gz`);
  execFileSync('tar', ['-czf', archive, '-C', temp, name]);
  console.log(archive);
} finally { await rm(temp, { recursive: true, force: true }); }
