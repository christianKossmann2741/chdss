export class FilteredAudio {
  constructor(bridge, { contextFactory = () => new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' }), nodeFactory = context => new AudioWorkletNode(context, 'chdss-filtered-audio', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] }), onFailure = () => {} } = {}) {
    this.bridge = bridge;
    this.contextFactory = contextFactory;
    this.nodeFactory = nodeFactory;
    this.onFailure = onFailure;
    this.closed = false;
    this.earlyFailures = new Map();
  }

  async start(sourceId) {
    if (this.closed || this.context) throw new Error('Audio capture has already started or stopped.');
    try {
      this.context = this.contextFactory();
      await this.context.resume();
      if (this.context.sampleRate !== 48000) throw new Error('Filtered audio requires a 48 kHz audio context.');
      await this.context.audioWorklet.addModule('./audio-worklet.js');
      if (this.closed) throw new Error('Audio capture cancelled.');
      this.node = this.nodeFactory(this.context);
      this.destination = this.context.createMediaStreamDestination();
      this.node.connect(this.destination); // Never connect to local speakers.
      this.node.onprocessorerror = () => {
        if (this.closed) return;
        const message = 'The filtered audio processor stopped. Restart sharing.';
        if (!this.captureId) this.processorFailure = message;
        else this.onFailure(message);
      };
      this.removeData = this.bridge.onAudio(packet => {
        if (this.closed || !this.captureId || packet.captureId !== this.captureId) return;
        const bytes = packet.samples;
        if (!(bytes instanceof Uint8Array) || bytes.byteLength % 8 || bytes.byteLength > 7680) return;
        const copy = bytes.slice();
        const samples = new Float32Array(copy.buffer);
        this.node.port.postMessage(samples, [samples.buffer]);
      });
      this.removeFailure = this.bridge.onAudioFailure(packet => {
        if (this.closed) return;
        if (!this.captureId) {
          if (this.earlyFailures.size < 8) this.earlyFailures.set(packet.captureId, packet.message);
        } else if (packet.captureId === this.captureId) this.onFailure(packet.message);
      });
      const ready = await this.bridge.startAudio(sourceId);
      if (this.closed) throw new Error('Audio capture cancelled.');
      this.captureId = ready.captureId;
      const failure = this.earlyFailures.get(this.captureId) ?? this.processorFailure;
      this.earlyFailures.clear();
      if (failure) throw new Error(failure);
      return { track: this.destination.stream.getAudioTracks()[0], scope: ready.scope };
    } catch (error) { await this.stop(); throw error; }
  }

  async stop() {
    if (this.closed) return;
    this.closed = true;
    this.captureId = null;
    this.removeData?.();
    this.removeFailure?.();
    this.destination?.stream.getAudioTracks().forEach(track => track.stop());
    if (this.node) this.node.onprocessorerror = null;
    this.node?.disconnect();
    await Promise.allSettled([this.bridge.stopAudio(), this.context?.close()]);
  }
}
