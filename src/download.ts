import type { BoxDimensions, Orientation } from "./model/build";

export interface DownloadUpdate {
  blob: Blob;
  filename: string;
}

/**
 * Coordinates (re)generation of the downloadable 3MF file.
 *
 * The file always matches the last committed dimensions and the last resting
 * (static) orientation of the part. While a rotation animation is underway
 * the download is never updated: regeneration requests are deferred until the
 * part has settled into a resting position.
 */
export class DownloadManager {
  // The resting orientation the download should match
  private orientation: Orientation = 0;

  // Whether a rotation animation is currently underway
  private rotating = false;

  // Whether a regeneration is pending (deferred while rotating, or a build
  // was discarded because it finished mid-rotation)
  private dirty = false;

  // Identifies the latest build request, so stale builds are discarded
  private requestId = 0;

  public constructor(
    private dimensions: BoxDimensions,
    private readonly build: (
      dims: BoxDimensions,
      orientation: Orientation,
    ) => Promise<Blob>,
    private readonly filename: (dims: BoxDimensions) => string,
    private readonly onUpdate: (update: DownloadUpdate) => void,
  ) {}

  // The committed dimensions changed
  public setDimensions(dimensions: BoxDimensions): void {
    this.dimensions = dimensions;
    this.regenerate();
  }

  // The part snapped to a resting orientation. Never regenerates directly:
  // the part first animates to the new orientation, and the download is only
  // updated once the animation has settled (see setRotating).
  public setOrientation(orientation: Orientation): void {
    if (orientation === this.orientation) {
      return;
    }
    this.orientation = orientation;
    this.dirty = true;
  }

  // The rotation animation started (true) or settled (false)
  public setRotating(rotating: boolean): void {
    const settled = this.rotating && !rotating;
    this.rotating = rotating;
    if (settled && this.dirty) {
      this.regenerate();
    }
  }

  private regenerate(): void {
    if (this.rotating) {
      // Never update the download mid-rotation; retry once settled
      this.dirty = true;
      return;
    }

    this.dirty = false;

    const id = ++this.requestId;
    const dims = this.dimensions;
    const orientation = this.orientation;
    const filename = this.filename(dims);

    this.build(dims, orientation).then((blob) => {
      // Discard the build if a newer one was requested, or if a rotation
      // animation started while it was being built
      if (id !== this.requestId || this.rotating) {
        this.dirty = true;
        return;
      }
      this.onUpdate({ blob, filename });
    });
  }
}
