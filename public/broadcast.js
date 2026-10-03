import { audioConstraints } from './webrtc.js';

export const presets = Object.freeze({
  balanced: { height: 1080, fps: 30, bitrate: 5_000_000, hint: 'motion' },
  motion: { height: 1080, fps: 60, bitrate: 8_000_000, hint: 'motion' },
  detail: { height: 1440, fps: 30, bitrate: 8_000_000, hint: 'detail' },
  economy: { height: 720, fps: 30, bitrate: 2_500_000, hint: 'motion' }
});

export function captureOptions({ height, fps }, includeAudio) {
  return {
    video: { ...(Number.isFinite(height) ? { height: { ideal: height, max: height } } : {}), frameRate: { ideal: fps, max: fps } },
    audio: includeAudio ? audioConstraints() : false
  };
}

export function validateCapture(stream, includeAudio) {
  const videoTrack = stream.getVideoTracks()[0];
  const audioTrack = stream.getAudioTracks()[0];
  if (!videoTrack || (includeAudio && !audioTrack)) {
    stream.getTracks().forEach(track => track.stop());
    throw new Error(!videoTrack ? 'No screen was captured.' : 'Filtered system audio was not supplied. Check recording access and the native audio helper, then restart CHDSS. Uncheck Include filtered audio only if you intentionally want video only.');
  }
  return { videoTrack, audioTrack };
}

export function relayOrigin(value) {
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('Enter your server’s HTTPS origin, such as https://stream.example.com.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('The server must be a bare HTTPS origin, without a path, password, query, or fragment.');
  }
  return url.origin;
}
