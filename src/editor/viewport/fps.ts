/** The frame counter of the viewport (Settings → Show FPS): frames drawn in the last second and how long the last one took. */
export class FpsMeter {
  private stamps: number[] = [];
  private lastMs = 0;

  /** A frame was drawn at `now` (ms) and took `ms`. */
  tick(now: number, ms: number) {
    this.stamps.push(now);
    this.lastMs = ms;
    const from = now - 1000;
    while (this.stamps.length && this.stamps[0] < from) this.stamps.shift();
  }

  /** Frames in the last second before `now`, and the time of the last frame. 0 frames when nothing was drawn for a second (the viewport only draws what changes). */
  read(now: number): { fps: number; ms: number } {
    const from = now - 1000;
    return { fps: this.stamps.filter((t) => t >= from).length, ms: this.lastMs };
  }
}

export const fpsMeter = new FpsMeter();
