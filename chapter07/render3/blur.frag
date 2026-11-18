precision mediump float;

varying vec2 fTexCoord;

uniform sampler2D texture;
uniform float blurDistance;

void main()
{
  float s = 4.0;
  // 模糊距离直接作为纹理坐标偏移使用，不再做任何缩放：
  // 距离为 0 时四个采样点都落在当前纹素上，输出与原图一致。
  float d = blurDistance;
  float x = fTexCoord.x;
  float y = fTexCoord.y;

  vec4 convCore = ( texture2D( texture, vec2( x + d, y))
                   + texture2D( texture, vec2( x, y + d))
                   + texture2D( texture, vec2( x - d, y))
                   + texture2D( texture, vec2( x, y - d)) ) / s;

  gl_FragColor = convCore;
}
