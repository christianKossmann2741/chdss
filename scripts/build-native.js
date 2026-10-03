import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const value = flag => process.argv[process.argv.indexOf(flag) + 1];
const platform = process.argv.includes('--platform') ? value('--platform') : process.platform;
const arch = process.argv.includes('--arch') ? value('--arch') : process.arch;
if (!['darwin', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch)) throw new Error('Unsupported native audio target.');
const executable = platform === 'win32' ? 'chdss-audio.exe' : 'chdss-audio';
const binary = resolve(`native/bin/${platform}-${arch}/${executable}`);
if (platform === process.platform) {
  const command = platform === 'darwin' ? 'bash' : 'powershell.exe';
  const args = platform === 'darwin' ? ['native/macos/build.sh', arch] : ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'native/windows/build.ps1'];
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
} else if (!existsSync(binary)) {
  throw new Error(`Cross-packaging requires a precompiled helper at ${binary}. Build it on the target OS first; unfiltered loopback is not a fallback.`);
}
const bytes = readFileSync(binary);
if (platform === 'win32') {
  if (arch !== 'x64' || bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error('Expected a Windows x64 PE helper.');
  const offset = bytes.readUInt32LE(0x3c);
  if (bytes.toString('ascii', offset, offset + 4) !== 'PE\0\0' || bytes.readUInt16LE(offset + 4) !== 0x8664) throw new Error('Native helper is not Windows x64.');
} else if (bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== (arch === 'arm64' ? 0x100000c : 0x1000007)) {
  throw new Error('Native audio helper has the wrong Mach-O architecture.');
}
console.log(`Verified native audio helper: ${binary}`);
