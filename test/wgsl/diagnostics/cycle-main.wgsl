#include /test/wgsl/diagnostics/cycle-a.wgsl

@fragment
fn mainFrag() -> @location(0) vec4f {
  return vec4f(0.0);
}
