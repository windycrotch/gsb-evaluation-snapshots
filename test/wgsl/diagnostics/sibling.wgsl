// Imports the same chunk that `chunk0.wgsl` imports through `utils/chunk1.wgsl`,
// so `chunk3.wgsl` ends up being imported by two different parent files.
#include /test/wgsl/chunk3.wgsl;

fn siblingGreen() -> f32 {
  return chunkGreen();
}
