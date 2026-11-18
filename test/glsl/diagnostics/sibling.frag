// Imports the same chunk that `chunk0.frag` imports through `utils/chunk1.glsl`,
// so `chunk3.frag` ends up being imported by two different parent files.
#include /test/glsl/chunk3.frag;

float siblingGreen () {
  return chunkGreen();
}
