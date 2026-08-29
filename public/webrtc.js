export function audioConstraints() {
  return {
    channelCount: { ideal: 2 },
    sampleRate: { ideal: 48000 },
    sampleSize: { ideal: 16 },
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false
  };
}

export function connectionPolicy() {
  return { iceServers: [], bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' };
}

export async function tuneSender(sender, options = {}) {
  if (!sender?.track) return;
  const parameters = sender.getParameters();
  parameters.encodings ??= [{}];
  parameters.encodings[0] ??= {};
  const encoding = parameters.encodings[0];
  encoding.priority = 'high';
  encoding.networkPriority = 'high';
  if (sender.track.kind === 'video') {
    sender.track.contentHint = 'motion';
    if (options.maxBitrate) encoding.maxBitrate = options.maxBitrate;
    if (options.maxFramerate) encoding.maxFramerate = options.maxFramerate;
  } else if (sender.track.kind === 'audio') {
    sender.track.contentHint = 'music';
    encoding.maxBitrate = 192_000;
  }
  await sender.setParameters(parameters);
}

export function preferOpusStereo(description) {
  if (!description?.sdp) return description;
  const lines = description.sdp.split('\r\n');
  const opus = lines.find(line => /^a=rtpmap:(\d+) opus\/48000\/2$/i.test(line));
  if (!opus) return description;
  const payload = opus.match(/^a=rtpmap:(\d+)/i)[1];
  const fmtpPrefix = `a=fmtp:${payload}`;
  const index = lines.findIndex(line => line.startsWith(fmtpPrefix));
  const settings = 'stereo=1;sprop-stereo=1;useinbandfec=1;usedtx=0;maxaveragebitrate=192000';
  if (index >= 0) lines[index] = `${lines[index]};${settings}`;
  else lines.splice(lines.indexOf(opus) + 1, 0, `${fmtpPrefix} ${settings}`);
  return { ...description, sdp: lines.join('\r\n') };
}
