import { spawn as spawnProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export function audioHelperPath({ packaged = false, resourcesPath, platform = process.platform, arch = process.arch } = {}) {
  const executable = platform === 'win32' ? 'chdss-audio.exe' : 'chdss-audio';
  return packaged ? join(resourcesPath, 'native', executable) : fileURLToPath(new URL(`../native/bin/${platform}-${arch}/${executable}`, import.meta.url));
}

// Native helpers are the only audio source. Never fall back to mixed loopback.
export class NativeAudioCapture extends EventEmitter {
  constructor({ spawn = spawnProcess, helperPath = audioHelperPath(), startupTimeout = 15_000 } = {}) {
    super();
    this.spawn = spawn;
    this.helperPath = helperPath;
    this.startupTimeout = startupTimeout;
    this.generation = 0;
    this.child = null;
    this.cancelStart = null;
    this.closing = Promise.resolve();
  }

  async start(sourceId) {
    if (typeof sourceId !== 'string' || !/^(window|screen):\d+:\d+$/.test(sourceId)) throw new Error('Invalid screen or window source identifier.');
    const generation = ++this.generation;
    await this.closeChild();
    if (generation !== this.generation) throw new Error('Audio capture startup cancelled.');
    const captureId = randomUUID();
    let child;
    try { child = this.spawn(this.helperPath, ['--source', sourceId], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
    catch (error) { throw new Error(`Filtered system audio could not start: ${error.message}`); }
    this.child = child;
    return new Promise((resolve, reject) => {
      let ready = false;
      let settled = false;
      let failed = false;
      let pending = Buffer.alloc(0);
      let status = '';
      const current = () => generation === this.generation && this.child === child;
      const fail = error => {
        if (failed) return;
        failed = true;
        clearTimeout(deadline);
        if (!settled) { settled = true; reject(error); }
        else if (current()) this.emit('failure', { captureId, message: error.message });
        if (current()) { this.cancelStart = null; void this.stop(); }
      };
      const deadline = setTimeout(() => fail(new Error('Filtered system audio timed out. Check recording permission and restart CHDSS.')), this.startupTimeout);
      this.cancelStart = () => fail(new Error('Audio capture startup cancelled.'));
      child.once('error', error => fail(new Error(`Filtered system audio helper unavailable: ${error.message}. Reinstall this build; unfiltered audio will not be used.`)));
      child.once('exit', (code, signal) => {
        if (current()) fail(new Error(`Filtered system audio stopped (${signal ?? code}). Sharing must be restarted.`));
      });
      child.stdin.on('error', () => {});
      child.stderr.on('data', chunk => {
        if (!current() || failed) return;
        status += chunk.toString('utf8');
        if (status.length > 65_536) { fail(new Error('Invalid audio helper status.')); return; }
        let end;
        while ((end = status.indexOf('\n')) >= 0) {
          const line = status.slice(0, end); status = status.slice(end + 1);
          let message;
          try { message = JSON.parse(line); } catch { continue; /* OS diagnostics are not audio. */ }
          if (message.type === 'error') { fail(new Error(String(message.message ?? 'Native audio filtering failed.').slice(0, 4096))); return; }
          if (message.type === 'ready' && !ready) {
            if (message.sampleRate !== 48000 || message.channels !== 2 || !['application', 'display'].includes(message.scope)) { fail(new Error('Unsupported native audio format or capture scope.')); return; }
            ready = true; settled = true;
            clearTimeout(deadline);
            this.cancelStart = null;
            resolve({ captureId, sampleRate: 48000, channels: 2, scope: message.scope });
          }
        }
      });
      child.stdout.on('data', chunk => {
        if (!current() || failed || !ready) return;
        // 20 ms packets; chunks may split a float or contain many packets.
        const bytes = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        let offset = 0;
        while (offset + 7680 <= bytes.length) {
          this.emit('data', { captureId, samples: Uint8Array.from(bytes.subarray(offset, offset + 7680)) });
          offset += 7680;
        }
        pending = Buffer.from(bytes.subarray(offset));
      });
    });
  }

  async closeChild() {
    const child = this.child;
    this.child = null;
    const cancel = this.cancelStart;
    this.cancelStart = null;
    cancel?.();
    if (!child || child.exitCode !== null || child.signalCode !== null) return this.closing;
    this.closing = this.closing.then(() => new Promise(resolve => {
      const deadline = setTimeout(() => { if (!child.kill('SIGKILL')) resolve(); }, 1500);
      child.once('close', () => { clearTimeout(deadline); resolve(); });
      child.stdin.end();
    }));
    return this.closing;
  }

  async stop() {
    this.generation++;
    await this.closeChild();
  }
}
