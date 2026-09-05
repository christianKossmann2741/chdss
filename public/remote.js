export class RelayPublisher {
  #room;
  #sdk;
  #tracks = [];
  #generation = 0;
  #load;
  #state;
  constructor(onState, load = () => import('./vendor/livekit-client.js')) { this.#state = onState; this.#load = load; }
  get connected() { return Boolean(this.#room); }
  get viewers() { return this.#room?.remoteParticipants.size ?? 0; }

  async connect(session) {
    if (!session?.token || new URL(session.url).protocol !== 'wss:') throw new Error('The server did not return a secure media endpoint.');
    this.#sdk = await this.#load();
    const { Room, RoomEvent } = this.#sdk;
    const room = new Room({ adaptiveStream: true, dynacast: true, disconnectOnPageLeave: true });
    for (const event of [RoomEvent.ParticipantConnected, RoomEvent.ParticipantDisconnected]) {
      if (event) room.on(event, () => this.#state('connected', this.viewers));
    }
    if (RoomEvent.Reconnecting) room.on(RoomEvent.Reconnecting, () => this.#state('reconnecting', this.viewers));
    if (RoomEvent.Reconnected) room.on(RoomEvent.Reconnected, () => this.#state('connected', this.viewers));
    if (RoomEvent.Disconnected) room.on(RoomEvent.Disconnected, () => {
      if (this.#room === room) { this.#room = null; this.#tracks.forEach(track => track.stop()); this.#tracks = []; this.#state('disconnected', 0); }
    });
    this.#room = room;
    try { await room.connect(session.url, session.token, { autoSubscribe: false }); }
    catch (error) { await this.disconnect(); throw error; }
    this.#state('connected', this.viewers);
  }

  async publish(stream, { bitrate, fps }) {
    if (!this.#room) return;
    await this.unpublish();
    const room = this.#room;
    const generation = ++this.#generation;
    const { Track } = this.#sdk;
    try {
      for (const original of stream.getTracks()) {
        if (generation !== this.#generation || room !== this.#room) return;
        const track = original.clone();
        this.#tracks.push(track);
        await room.localParticipant.publishTrack(track, {
          source: track.kind === 'video' ? Track.Source.ScreenShare : Track.Source.ScreenShareAudio,
          videoCodec: 'vp8', simulcast: false, videoEncoding: { maxBitrate: bitrate, maxFramerate: fps },
          audioPreset: { maxBitrate: 192_000 }, dtx: false, red: true, forceStereo: true
        });
        if (generation !== this.#generation || room !== this.#room) {
          track.stop();
          await room.localParticipant.unpublishTrack(track, false);
          return;
        }
      }
    } catch (error) { if (generation === this.#generation) await this.unpublish(); throw error; }
  }

  setAudioEnabled(enabled) { for (const track of this.#tracks) if (track.kind === 'audio') track.enabled = enabled; }

  async unpublish() {
    ++this.#generation;
    const tracks = this.#tracks.splice(0);
    await Promise.all(tracks.map(async track => {
      track.stop();
      await this.#room?.localParticipant.unpublishTrack(track, false);
    }));
  }

  async disconnect() {
    try { await this.unpublish(); }
    finally {
      const room = this.#room;
      this.#room = null;
      await room?.disconnect();
      this.#state('disconnected', 0);
    }
  }
}
