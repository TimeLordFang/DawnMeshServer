export interface GatedTrack {
  mediaStreamTrack: { enabled: boolean; stop(): void };
  mute(): Promise<unknown>;
  unmute(): Promise<unknown>;
  stop(): void;
}

/** Serializes SDK operations while immediately closing the hardware gate on
 * release. A late unmute/publish cannot leave a released press transmitting. */
export class MicrophoneGate {
  private wanted = false;
  private disposed = false;
  private pending: Promise<void> = Promise.resolve();
  private track: GatedTrack | null = null;

  attach(track: GatedTrack): void {
    if (this.disposed) { track.stop(); return; }
    this.track = track;
    track.mediaStreamTrack.enabled = false;
  }

  set(enabled: boolean): Promise<void> {
    this.wanted = enabled && !this.disposed;
    if (!this.wanted && this.track) this.track.mediaStreamTrack.enabled = false;
    this.pending = this.pending.catch(() => {}).then(async () => {
      const track = this.track;
      if (!track || this.disposed) return;
      if (this.wanted) await track.unmute();
      if (this.disposed) {
        // SDK unmute may reacquire a device after the original track ended.
        // A late completion must release that replacement as well.
        track.mediaStreamTrack.enabled = false;
        track.stop();
        return;
      }
      if (!this.wanted || this.disposed) {
        track.mediaStreamTrack.enabled = false;
        await track.mute();
      }
    });
    return this.pending;
  }

  dispose(): void {
    this.disposed = true;
    this.wanted = false;
    if (this.track) {
      this.track.mediaStreamTrack.enabled = false;
      this.track.stop();
    }
  }
}
