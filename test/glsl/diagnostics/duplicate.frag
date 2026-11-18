#version 300 es

precision mediump float;

out vec4 fragColor;

#include /test/glsl/chunk0.frag
#include /test/glsl/diagnostics/sibling.frag

void main (void) {
  fragColor = vec4(chunkFn().rgb, siblingGreen());
}
