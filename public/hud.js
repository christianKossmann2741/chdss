// Shared HUD helpers for the studio and the viewer. Everything degrades to plain text without a DOM clock.
const GLYPHS = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#%&*+=/<>';
const frame = callback => typeof globalThis.requestAnimationFrame === 'function' ? globalThis.requestAnimationFrame(callback) : null;
const cancelFrame = id => { if (id !== null && typeof globalThis.cancelAnimationFrame === 'function') globalThis.cancelAnimationFrame(id); };
const running = new WeakMap();
const glyph = () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)];

export function reducedMotion() {
  try { return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false; } catch { return false; }
}

const animates = () => typeof globalThis.requestAnimationFrame === 'function' && !reducedMotion();

function stop(element) {
  cancelFrame(running.get(element) ?? null);
  running.delete(element);
}

/** Resolves text left to right out of random glyphs, like a HUD acquiring a lock. */
export function scramble(element, text, { duration = 480 } = {}) {
  if (!element) return;
  const target = String(text);
  stop(element);
  if (!animates() || element.textContent === target) { element.textContent = target; return; }
  const started = performance.now();
  const tick = now => {
    const progress = Math.min(1, (now - started) / duration);
    const settled = Math.floor(progress * target.length);
    let output = target.slice(0, settled);
    for (let i = settled; i < target.length; i++) output += target[i] === ' ' ? ' ' : glyph();
    element.textContent = output;
    if (progress < 1) running.set(element, frame(tick));
    else { element.textContent = target; running.delete(element); }
  };
  running.set(element, frame(tick));
}

/** Types text with a block cursor (styled by .typing). */
export function typewriter(element, text, { cps = 55 } = {}) {
  if (!element) return;
  const target = String(text);
  if (element.textContent === target && !running.has(element)) return;
  stop(element);
  element.classList?.add('typing');
  if (!animates()) { element.textContent = target; return; }
  const started = performance.now();
  const tick = now => {
    const count = Math.min(target.length, Math.floor((now - started) / 1000 * cps));
    element.textContent = target.slice(0, count);
    if (count < target.length) running.set(element, frame(tick));
    else running.delete(element);
  };
  element.textContent = '';
  running.set(element, frame(tick));
}

export function timecode(totalSeconds) {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(value => String(value).padStart(2, '0')).join(':');
}

export function clock(date = new Date()) {
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map(value => String(value).padStart(2, '0')).join(':');
}

export function groupDigits(value) {
  return Math.round(Number(value) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function formatBitrate(bitsPerSecond) {
  const value = Number(bitsPerSecond);
  if (!Number.isFinite(value) || value <= 0) return '0 kbps';
  return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)} Mbps` : `${Math.round(value / 1000)} kbps`;
}

/** Split-flap digits: changed cells riffle through glyphs before settling. */
export class FlapBoard {
  constructor(element, { length = 2, pad = '0' } = {}) {
    this.element = element;
    this.length = length;
    this.pad = pad;
    this.value = '';
    this.cells = [];
    if (!element?.ownerDocument) return;
    element.replaceChildren(...Array.from({ length }, () => {
      const cell = element.ownerDocument.createElement('span');
      cell.className = 'flap';
      cell.textContent = pad;
      return cell;
    }));
    this.cells = [...element.children];
  }

  set(value) {
    const text = String(value).slice(-this.length).padStart(this.length, this.pad);
    if (text === this.value) return;
    const previous = this.value;
    this.value = text;
    if (!this.cells.length) { if (this.element) this.element.textContent = text; return; }
    this.cells.forEach((cell, index) => {
      if (previous[index] === text[index]) return;
      stop(cell);
      if (!animates()) { cell.textContent = text[index]; return; }
      let flips = 0;
      let last = 0;
      const total = 3 + index * 2;
      const pool = /\d/.test(text[index]) ? '0123456789' : GLYPHS;
      const tick = now => {
        if (now - last > 45) {
          last = now;
          cell.classList.remove('flip');
          void cell.offsetWidth;
          cell.classList.add('flip');
          cell.textContent = ++flips >= total ? text[index] : pool[Math.floor(Math.random() * pool.length)];
        }
        if (cell.textContent !== text[index] || flips < total) running.set(cell, frame(tick));
        else running.delete(cell);
      };
      running.set(cell, frame(tick));
    });
  }
}

/** Rolling level bars. Levels are 0..1. */
export class Waveform {
  constructor(element, { bars = 40 } = {}) {
    this.levels = new Array(bars).fill(0);
    this.bars = [];
    if (!element?.ownerDocument) return;
    element.replaceChildren(...this.levels.map(() => element.ownerDocument.createElement('i')));
    this.bars = [...element.children];
    this.render();
  }

  push(level) {
    this.levels.shift();
    this.levels.push(Math.max(0, Math.min(1, Number(level) || 0)));
    this.render();
  }

  clear() { this.levels.fill(0); this.render(); }

  render() {
    this.bars.forEach((bar, index) => { bar.style.transform = `scaleY(${Math.max(0.06, this.levels[index])})`; });
  }
}

/** A canvas line chart with a dashed ceiling, used for bitrate. */
export class Sparkline {
  constructor(canvas, { capacity = 60 } = {}) {
    this.canvas = canvas;
    this.capacity = capacity;
    this.values = [];
    this.ceiling = 0;
  }

  push(value) {
    this.values.push(Math.max(0, Number(value) || 0));
    if (this.values.length > this.capacity) this.values.shift();
    this.draw();
  }

  clear() { this.values = []; this.draw(); }

  draw() {
    const canvas = this.canvas;
    const context = canvas?.getContext?.('2d');
    if (!context) return;
    const ratio = globalThis.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    context.clearRect(0, 0, width, height);
    const styles = globalThis.getComputedStyle?.(canvas);
    const accent = styles?.getPropertyValue('--signal').trim() || '#ff5b35';
    const grid = styles?.getPropertyValue('--line').trim() || 'rgba(236,235,228,.16)';
    const top = Math.max(this.ceiling * 1.15, ...this.values, 1);
    const y = value => height - 2 * ratio - (value / top) * (height - 6 * ratio);
    context.strokeStyle = grid;
    context.lineWidth = ratio;
    for (let row = 1; row < 4; row++) {
      context.beginPath();
      context.moveTo(0, Math.round(height * row / 4) + 0.5);
      context.lineTo(width, Math.round(height * row / 4) + 0.5);
      context.stroke();
    }
    if (this.ceiling) {
      context.setLineDash([4 * ratio, 4 * ratio]);
      context.strokeStyle = accent;
      context.globalAlpha = 0.7;
      context.beginPath();
      context.moveTo(0, y(this.ceiling));
      context.lineTo(width, y(this.ceiling));
      context.stroke();
      context.setLineDash([]);
      context.globalAlpha = 1;
    }
    if (!this.values.length) return;
    const step = width / Math.max(1, this.capacity - 1);
    const offset = width - (this.values.length - 1) * step;
    context.strokeStyle = accent;
    context.lineWidth = 1.5 * ratio;
    context.beginPath();
    this.values.forEach((value, index) => { const x = offset + index * step; if (index) context.lineTo(x, y(value)); else context.moveTo(x, y(value)); });
    context.stroke();
    const last = this.values.at(-1);
    context.fillStyle = accent;
    context.beginPath();
    context.arc(width - 3 * ratio, y(last), 3 * ratio, 0, Math.PI * 2);
    context.fill();
  }
}

/** Fills a marquee with two identical runs so the CSS loop is seamless. */
export class Ticker {
  constructor(track) {
    this.track = track;
    this.signature = '';
  }

  set(items) {
    const track = this.track;
    if (!track?.ownerDocument) return;
    const signature = items.map(([label]) => label).join('|');
    if (signature !== this.signature) {
      this.signature = signature;
      const run = () => {
        const element = track.ownerDocument.createElement('span');
        element.className = 'ticker-run';
        for (const [label] of items) {
          const item = track.ownerDocument.createElement('span');
          item.className = 'ticker-item';
          const name = track.ownerDocument.createElement('b');
          name.textContent = label;
          item.append(name, track.ownerDocument.createElement('span'));
          element.append(item);
        }
        return element;
      };
      track.replaceChildren(run(), run());
    }
    for (const runElement of track.children) {
      [...runElement.children].forEach((item, index) => {
        const [, value, state] = items[index];
        if (item.lastChild.textContent !== value) item.lastChild.textContent = value;
        item.classList.toggle('hot', state === 'hot');
      });
    }
  }
}

/** Decorative, deterministic barcode bars from any non-secret label. */
export function barcode(svg, label) {
  if (!svg?.ownerDocument) return;
  let seed = 2166136261;
  for (const character of String(label)) seed = Math.imul(seed ^ character.charCodeAt(0), 16777619) >>> 0;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
  const bars = [];
  let x = 0;
  while (x < 118) {
    const width = 1 + Math.floor(random() * 3);
    if (random() > 0.38) bars.push(`M${x + width / 2} 0V30`);
    x += width + 1 + Math.floor(random() * 2);
  }
  svg.setAttribute('viewBox', '0 0 120 30');
  const path = svg.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', bars.join(''));
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.4');
  svg.replaceChildren(path);
}

/** Staggered boot-in for elements carrying data-boot; labels with data-scramble resolve as they appear. */
export function boot(root = globalThis.document) {
  if (!root?.querySelectorAll) return;
  root.documentElement?.classList.add('booting');
  root.querySelectorAll('[data-scramble]').forEach((element, index) => {
    const text = element.textContent;
    if (!animates()) return;
    element.textContent = '';
    setTimeout(() => scramble(element, text, { duration: 520 }), 120 + index * 35);
  });
  setTimeout(() => root.documentElement?.classList.remove('booting'), 1400);
}
