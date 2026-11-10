import {
  AdditiveBlending,
  AlwaysStencilFunc,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  EqualStencilFunc,
  Mesh,
  ShaderMaterial,
  Vector3,
} from '@iwsdk/core';
import { config } from '../config.js';
import { TIME } from './constants.js';

/**
 * The glowing rim of the time lens: ONE draw call.
 *
 * The lens "glass" is the stage sphere itself (Track B's shader, masked by angle from
 * `lens.direction`). That mask lives at infinity, so the rim has to live there too or the
 * two would not line up in each eye. The rim is therefore not a ring glued to the hand but
 * a thin band of a head-centred sphere: each vertex is placed in the vertex shader at
 * `angle = lensRadius + offset` from the lens axis, far away. It follows the same direction
 * and radius numbers the stage gets, so rim and mask agree by construction, for any radius
 * from 0 to PI (push-through).
 *
 * It also draws the opening ripple (two rings travelling outward) and a slow shimmer. Both
 * are additive glow only; nothing here warps the panorama.
 */

const VERT = /* glsl */ `
uniform vec3 uCenter;
uniform vec3 uAxis;
uniform float uRadius;
uniform float uInner;
uniform float uOuter;
uniform float uDistance;
varying float vOff;
varying float vPhi;
const float PI = 3.14159265359;

void main() {
  // position.x: 0..1 around the rim. position.y: 0 (inner edge) .. 1 (outer edge).
  float phi = position.x * 2.0 * PI;
  float ang = clamp(uRadius + mix(-uInner, uOuter, position.y), 0.0, PI);
  vOff = ang - uRadius;
  vPhi = phi;
  vec3 ref = abs(uAxis.y) > 0.99 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  vec3 bu = normalize(cross(ref, uAxis));
  vec3 bv = cross(uAxis, bu);
  vec3 dir = cos(ang) * uAxis + sin(ang) * (cos(phi) * bu + sin(phi) * bv);
  gl_Position = projectionMatrix * viewMatrix * vec4(uCenter + dir * uDistance, 1.0);
}`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uTime;
uniform float uOpacity;
uniform float uRipple;
uniform float uOuter;
uniform float uInner;
varying float vOff;
varying float vPhi;

float ring(float off, float centre, float width) {
  float x = (off - centre) / width;
  return exp(-x * x);
}

void main() {
  // Thin bright line on the mask edge, soft halo either side.
  float line = ring(vOff, 0.0, 0.007);
  float halo = vOff > 0.0 ? exp(-vOff / 0.04) * 0.30 : exp(vOff / 0.014) * 0.22;
  // Slow shimmer travelling round the rim (two gentle waves, under 0.2 Hz).
  float shimmer = 0.78 + 0.22 * sin(vPhi * 3.0 + uTime * 0.9) * sin(vPhi * 5.0 - uTime * 0.6);
  // Opening ripple: two rings leave the rim and fade as they travel outward.
  float r1 = uRipple;
  float r2 = clamp(uRipple * 1.6 - 0.6, 0.0, 1.0);
  float travel = uOuter * 0.85;
  float ripple = ring(vOff, r1 * travel, 0.010) * (1.0 - r1) * (1.0 - r1) * step(0.001, r1)
               + ring(vOff, r2 * travel, 0.010) * (1.0 - r2) * (1.0 - r2) * step(0.001, r2) * 0.6;
  // Fade to nothing at both band edges so the geometry never shows.
  float edge = (1.0 - smoothstep(uOuter * 0.7, uOuter, vOff)) * smoothstep(-uInner, -uInner * 0.6, vOff);
  float a = (line * shimmer + halo * shimmer + ripple * 0.8) * edge * uOpacity;
  gl_FragColor = vec4(uColor * a, a);
  #include <colorspace_fragment>
}`;

function bandGeometry(segments: number, rows: number): BufferGeometry {
  const cols = segments + 1;
  const positions = new Float32Array(cols * (rows + 1) * 3);
  let p = 0;
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c < cols; c++) {
      positions[p++] = c / segments;
      positions[p++] = r / rows;
      positions[p++] = 0;
    }
  }
  const index = new Uint16Array(segments * rows * 6);
  let i = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < segments; c++) {
      const a = r * cols + c;
      const b = a + 1;
      const d = a + cols;
      const e = d + 1;
      index[i++] = a;
      index[i++] = d;
      index[i++] = b;
      index[i++] = b;
      index[i++] = d;
      index[i++] = e;
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(positions, 3));
  geo.setIndex(new BufferAttribute(index, 1));
  return geo;
}

/** Warm gold for a year with a panorama, cool grey-blue for an archive stop. */
const COLOR_PANO = new Color(1.0, 0.82, 0.45);
const COLOR_ARCHIVE = new Color(0.55, 0.7, 1.0);

export class LensRim {
  readonly mesh: Mesh;
  private readonly material: ShaderMaterial;
  private readonly center = new Vector3();
  private readonly axis = new Vector3(0, 0, -1);

  constructor() {
    this.material = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      // Not `transparent`: that would sort it after the hands and UI. As an "opaque" object
      // with additive blending it draws right after the stage sphere, and everything else
      // (hands, panels) draws over it.
      transparent: false,
      blending: AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
      uniforms: {
        uCenter: { value: this.center },
        uAxis: { value: this.axis },
        uRadius: { value: 0 },
        uInner: { value: TIME.rimInnerRad },
        uOuter: { value: TIME.rimOuterRad },
        uDistance: { value: config.sphereRadiusM * TIME.rimDistanceFactor },
        uColor: { value: new Color().copy(COLOR_PANO) },
        uTime: { value: 0 },
        uOpacity: { value: 0 },
        uRipple: { value: 1 },
      },
    });
    this.mesh = new Mesh(bandGeometry(TIME.rimSegments, 6), this.material);
    this.mesh.name = 'TimeLensRim';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -999; // the stage sphere is -1000
    this.mesh.visible = false;
  }

  hide(): void {
    this.mesh.visible = false;
  }

  /**
   * Per-frame, allocation-free. `head` and `direction` are world space; `radius` is the
   * same angular radius the stage was given; `ripple` runs 0 to 1 while the lens opens.
   */
  update(
    head: Vector3,
    direction: Vector3,
    radius: number,
    opacity: number,
    ripple: number,
    timeSec: number,
    archive: boolean,
    stencilRef: number | null,
  ): void {
    const m = this.material;
    this.mesh.visible = opacity > 0.001;
    this.center.copy(head);
    this.axis.copy(direction);
    m.uniforms.uRadius.value = radius;
    m.uniforms.uOpacity.value = archive ? opacity * 0.6 : opacity;
    m.uniforms.uRipple.value = ripple;
    m.uniforms.uTime.value = timeSec;
    (m.uniforms.uColor.value as Color).copy(archive ? COLOR_ARCHIVE : COLOR_PANO);
    // In portal mode the stage draws only inside the window's stencil; so must the rim.
    if (stencilRef === null) {
      m.stencilWrite = false;
      m.stencilFunc = AlwaysStencilFunc;
    } else {
      m.stencilWrite = true; // enables the stencil test; default ops keep the buffer as is
      m.stencilFunc = EqualStencilFunc;
      m.stencilRef = stencilRef;
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
