import {
  BackSide,
  EqualStencilFunc,
  KeepStencilOp,
  Mesh,
  MathUtils,
  Object3D,
  SphereGeometry,
  SRGBColorSpace,
  ShaderMaterial,
  Texture,
  TextureLoader,
  Vector3,
} from '@iwsdk/core';
import type { World } from '@iwsdk/core';
import { config } from '../config.js';
import type { EventBus, Pano, PanoLens, PanoStage } from '../contracts.js';

const VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

/**
 * Samples by VIEW DIRECTION (see the pano-rendering skill). World north is -Z, east +X.
 * A panorama's centre column looks toward its heading, so
 *   u = 0.5 + (azimuth - heading) / 2pi, with azimuth = atan(d.x, -d.z) (clockwise from north).
 */
const FRAG = /* glsl */ `
uniform sampler2D uCur;
uniform sampler2D uPast;
uniform float uCurHeading;
uniform float uPastHeading;
uniform float uPastOn;
uniform float uRadius;
uniform float uFeather;
uniform float uTime;
uniform vec3 uLensDir;
varying vec3 vWorld;
const float PI = 3.14159265359;

vec2 dirToUv(vec3 d, float headingRad) {
  float az = atan(d.x, -d.z);
  float u = 0.5 + (az - headingRad) / (2.0 * PI);
  float v = 0.5 + asin(clamp(d.y, -1.0, 1.0)) / PI;
  return vec2(fract(u), v);
}

void main() {
  vec3 d = normalize(vWorld - cameraPosition);
  float angle = acos(clamp(dot(d, uLensDir), -1.0, 1.0));
  float mask = uPastOn * (1.0 - smoothstep(uRadius - uFeather, uRadius + uFeather, angle));
  if (uRadius >= PI) mask = uPastOn;
  vec3 cur = texture2D(uCur, dirToUv(d, uCurHeading)).rgb;
  vec3 past = texture2D(uPast, dirToUv(d, uPastHeading)).rgb;
  vec3 col = mix(cur, past, mask);
  // faint rim glow so the lens edge is visible in the mock
  float rim = (1.0 - smoothstep(0.0, uFeather * 2.0, abs(angle - uRadius))) * uPastOn;
  col += rim * 0.35 * (0.8 + 0.2 * sin(uTime * 3.0));
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

const loader = new TextureLoader();

function loadTexture(url: string): Promise<Texture> {
  return new Promise((resolve, reject) => {
    loader.load(
      url,
      (tex) => {
        tex.colorSpace = SRGBColorSpace;
        tex.generateMipmaps = false;
        resolve(tex);
      },
      undefined,
      () => reject(new Error(`mock stage: could not load ${url}`)),
    );
  });
}

/**
 * A small but REAL stage: inside-out sphere, two textures, lens mask, no fades, no downscaling.
 * Tracks C, E, F and G develop against it. Track B replaces it with the production stage.
 */
export class MockPanoStage implements PanoStage {
  readonly root = new Object3D();
  readonly lens: PanoLens = {
    enabled: false,
    pastTexture: null,
    pastHeading: 0,
    direction: new Vector3(0, 0, -1),
    radius: config.lens.defaultRadius,
    feather: config.lens.feather,
    time: 0,
  };
  stencilRef: number | null = null;
  currentPano: Pano | null = null;
  currentTexture: Texture | null = null;

  private pastPano: Pano | null = null;
  private readonly material: ShaderMaterial;
  private readonly sphere: Mesh;
  private readonly camPos = new Vector3();
  private blank: Texture;

  constructor(
    world: World,
    private readonly bus: EventBus,
  ) {
    this.blank = new Texture();
    this.material = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: BackSide,
      depthWrite: false,
      uniforms: {
        uCur: { value: this.blank },
        uPast: { value: this.blank },
        uCurHeading: { value: 0 },
        uPastHeading: { value: 0 },
        uPastOn: { value: 0 },
        uRadius: { value: this.lens.radius },
        uFeather: { value: this.lens.feather },
        uTime: { value: 0 },
        uLensDir: { value: this.lens.direction },
      },
    });
    this.sphere = new Mesh(new SphereGeometry(config.sphereRadiusM, 64, 32), this.material);
    this.sphere.frustumCulled = false;
    this.sphere.renderOrder = -1000;
    this.sphere.visible = false;
    this.sphere.onBeforeRender = (_r, _s, camera) => this.beforeRender(camera);
    this.root.add(this.sphere);
    world.createTransformEntity(this.root, { persistent: true });
  }

  private beforeRender(camera: { matrixWorld: { elements: number[] } } & object): void {
    const m = this.material;
    this.camPos.setFromMatrixPosition(camera.matrixWorld as never);
    this.sphere.position.copy(this.camPos);
    const l = this.lens;
    m.uniforms.uPast.value = l.pastTexture ?? this.blank;
    m.uniforms.uPastOn.value = l.enabled && l.pastTexture ? 1 : 0;
    m.uniforms.uPastHeading.value = MathUtils.degToRad(l.pastHeading);
    m.uniforms.uRadius.value = l.radius;
    m.uniforms.uFeather.value = l.feather;
    m.uniforms.uTime.value = l.time;
    if (this.stencilRef === null) {
      m.stencilWrite = false;
    } else {
      // In three.js, stencilWrite is what ENABLES the stencil test. Mask 0 = never modify the buffer.
      m.stencilWrite = true;
      m.stencilWriteMask = 0x00;
      m.stencilFunc = EqualStencilFunc;
      m.stencilRef = this.stencilRef;
      m.stencilFuncMask = 0xff;
      m.stencilFail = KeepStencilOp;
      m.stencilZFail = KeepStencilOp;
      m.stencilZPass = KeepStencilOp;
    }
  }

  async show(pano: Pano): Promise<void> {
    const tex = await loadTexture(pano.imageUrl);
    this.currentTexture?.dispose();
    this.currentTexture = tex;
    this.currentPano = pano;
    this.material.uniforms.uCur.value = tex;
    this.material.uniforms.uCurHeading.value = MathUtils.degToRad(pano.heading);
    this.sphere.visible = true;
    this.bus.emit('pano:shown', { pano });
  }

  async loadPast(pano: Pano): Promise<Texture> {
    const tex = await loadTexture(pano.imageUrl);
    this.lens.pastTexture?.dispose();
    this.lens.pastTexture = tex;
    this.lens.pastHeading = pano.heading;
    this.pastPano = pano;
    return tex;
  }

  commitPast(): void {
    const { pastTexture } = this.lens;
    if (!pastTexture || !this.pastPano) return;
    this.currentTexture?.dispose();
    this.currentTexture = pastTexture;
    this.currentPano = this.pastPano;
    this.material.uniforms.uCur.value = pastTexture;
    this.material.uniforms.uCurHeading.value = MathUtils.degToRad(this.pastPano.heading);
    const pano = this.pastPano;
    this.lens.pastTexture = null;
    this.lens.enabled = false;
    this.pastPano = null;
    this.bus.emit('pano:shown', { pano });
  }

  clearPast(): void {
    this.lens.pastTexture?.dispose();
    this.lens.pastTexture = null;
    this.lens.enabled = false;
    this.pastPano = null;
  }

  setVisible(visible: boolean): void {
    this.sphere.visible = visible && this.currentTexture !== null;
  }

  textureCount(): number {
    return (this.currentTexture ? 1 : 0) + (this.lens.pastTexture ? 1 : 0);
  }
}
