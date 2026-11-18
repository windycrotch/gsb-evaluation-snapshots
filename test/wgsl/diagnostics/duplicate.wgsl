#include /test/wgsl/chunk0.wgsl
#include /test/wgsl/diagnostics/sibling.wgsl

@fragment
fn mainFrag() -> @location(0) vec4f
{
  return vec4f(chunkFn().rgb, siblingGreen());
}
