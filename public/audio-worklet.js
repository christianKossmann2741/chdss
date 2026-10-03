class FilteredAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capacity = 9600; // Bound accumulated delay to 200 ms.
    this.ring = new Float32Array(this.capacity * 2);
    this.readFrame = 0;
    this.writeFrame = 0;
    this.queuedFrames = 0;
    this.buffering = true;
    this.port.onmessage = event => {
      const pcm = event.data;
      if (!(pcm instanceof Float32Array) || pcm.length % 2 || pcm.length > 19200) return;
      for (let i = 0; i < pcm.length; i += 2) {
        if (this.queuedFrames === this.capacity) {
          this.readFrame = (this.readFrame + 1) % this.capacity;
          this.queuedFrames--;
        }
        for (let channel = 0; channel < 2; channel++) {
          const sample = pcm[i + channel];
          this.ring[this.writeFrame * 2 + channel] = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0;
        }
        this.writeFrame = (this.writeFrame + 1) % this.capacity;
        this.queuedFrames++;
      }
    };
  }

  process(_inputs, outputs) {
    const channels = outputs[0];
    if (!channels?.length) return true;
    channels.forEach(channel => channel.fill(0));
    if (this.buffering && this.queuedFrames < 1920) return true; // 40 ms.
    this.buffering = false;
    for (let frame = 0; frame < channels[0].length; frame++) {
      if (!this.queuedFrames) { this.buffering = true; break; }
      for (let channel = 0; channel < channels.length; channel++) channels[channel][frame] = this.ring[this.readFrame * 2 + Math.min(channel, 1)];
      this.readFrame = (this.readFrame + 1) % this.capacity;
      this.queuedFrames--;
    }
    return true;
  }
}
registerProcessor('chdss-filtered-audio', FilteredAudioProcessor);
