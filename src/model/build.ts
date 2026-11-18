import { box } from "./manifold";
import { exportManifold } from "./export";

// The resting orientations of the part on screen. 0 is the front of the part
// (clips pointing away from the viewer); -1 and +1 both show the back of the
// part (180° turn, counter-clockwise or clockwise respectively).
export type Orientation = -1 | 0 | 1;

// The rotation (in degrees, around the Z axis) to apply to the exported model
// so that the downloaded file matches the orientation seen on screen.
export function exportRotation(orientation: Orientation): number {
  return orientation === 0 ? 0 : 180;
}

// The (outer) dimensions of the box, as committed by the user
export interface BoxDimensions {
  height: number;
  width: number;
  depth: number;
  radius: number;
  wall: number;
  bottom: number;
}

// The name of the file the user downloads
export function downloadFilename(dims: BoxDimensions): string {
  return `skapa-${dims.width}-${dims.depth}-${dims.height}.3mf`;
}

// Build the 3MF blob for download, rotated so that its orientation matches
// the orientation currently shown on screen.
export async function buildDownload(
  dims: BoxDimensions,
  orientation: Orientation,
): Promise<Blob> {
  let model = await box(
    dims.height,
    dims.width,
    dims.depth,
    dims.radius,
    dims.wall,
    dims.bottom,
  );

  const rotation = exportRotation(orientation);
  if (rotation !== 0) {
    model = model.rotate([0, 0, rotation]);
  }

  return exportManifold(model);
}
