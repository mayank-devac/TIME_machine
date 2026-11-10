/**
 * Stage sphere shader. Samples both panoramas by VIEW DIRECTION (pano-rendering skill), so
 * the present, the lens and the portal stay registered whatever shape they are seen through.
 *
 * Alignment (proven against the Times Square fixtures, see README):
 *   azimuth = atan(d.x, -d.z)                    clockwise from north, world north = -Z
 *   u       = fract(0.5 + (azimuth - heading)/2pi)  centre column looks toward the heading
 *   v       = 0.5 - asin(d.y)/pi                  v = 0 is the image's top row (flipY off,
 *                                                 because ImageBitmap uploads ignore flipY)
 */

export const STAGE_VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

export const STAGE_FRAG = /* glsl */ `
uniform sampler2D uCur;
uniform sampler2D uPast;
uniform float uCurHeading;
uniform float uPastHeading;
uniform float uPastOn;
uniform float uRadius;
uniform float uFeather;
uniform float uTime;
uniform float uFade;
uniform float uMaxWarp;
uniform vec3 uLensDir;
varying vec3 vWorld;
const float PI = 3.14159265359;
const float TAU = 6.28318530718;

vec2 dirToUv(vec3 d, float headingRad) {
  float az = atan(d.x, -d.z);
  float u = 0.5 + (az - headingRad) / TAU;
  float v = 0.5 - asin(clamp(d.y, -1.0, 1.0)) / PI;
  return vec2(fract(u), v);
}

void main() {
  vec3 d = normalize(vWorld - cameraPosition);
  vec3 col = texture2D(uCur, dirToUv(d, uCurHeading)).rgb;

  if (uPastOn > 0.5) {
    float ang = acos(clamp(dot(d, uLensDir), -1.0, 1.0));
    float edge = ang - uRadius;
    float band = max(uFeather * 3.0, 0.002);
    float rim = (1.0 - smoothstep(0.0, band, abs(edge))) * step(uRadius, PI - 0.001);
    // Shimmer: a tiny, slow swirl of the sampling direction near the rim only.
    vec3 pd = d;
    vec3 axis = cross(uLensDir, d);
    float al = length(axis);
    if (rim > 0.0 && al > 1e-4) {
      pd = normalize(d + (axis / al) * uMaxWarp * rim * sin(ang * 60.0 - uTime * 2.0));
    }
    float mask = uRadius >= PI - 0.001 ? 1.0 : 1.0 - smoothstep(-uFeather, uFeather, edge);
    vec3 past = texture2D(uPast, dirToUv(pd, uPastHeading)).rgb;
    col = mix(col, past, mask);
    col += rim * 0.18 * (0.8 + 0.2 * sin(uTime * 1.5)) * vec3(0.75, 0.9, 1.0);
  }

  gl_FragColor = vec4(col * uFade, 1.0);
  #include <colorspace_fragment>
}`;
