import {
  BackSide,
  DataTexture,
  EqualStencilFunc,
  KeepStencilOp,
  LinearFilter,
  MathUtils,
  Mesh,
  Object3D,
  RGBAFormat,
  SRGBColorSpace,
  ShaderMaterial,
  SphereGeometry,
  Texture,
  Vector3,
} from '@iwsdk/core';
import type { Camera, Entity, World } from '@iwsdk/core';
import { config } from '../config.js';
import type { EventBus, Mode, Pano, PanoLens, PanoSource, PanoStage, Unsubscribe } from '../contracts.js';
import { PanoSphereTag } from '../track-components.js';
import { ARROW_MIN_SEPARATION_DEG, HopArrows, MAX_ARROWS } from './arrows.js';
import {
  Fader,
  LatestOnly,
  TextureLedger,
  abortError,
  browserLoaderDeps,
  firstSuccess,
  isAbortError,
  loadBitmap,
  sleep,
} from './lifecycle.js';
import type { LoaderDeps, RetryPolicy } from './lifecycle.js';
import { FrameGovernor, initialTier, pickArrowTargets, textureSizeFor, widthCap } from './pano-math.js';
import type { TextureKind, TextureSize } from './pano-math.js';
import { STAGE_FRAG, STAGE_VERT } from './stage-shader.js';

interface Slot {
  tex: Texture;
  bitmap: ImageBitmap;
  pano: Pano;
}

const now = (): number => performance.now();

const ON_HEADSET_BROWSER = typeof navigator !== 'undefined' && /OculusBrowser|Quest/i.test(navigator.userAgent);

/** Weak headset Wi-Fi: time out a stalled download and try once more. */
const PANO_RETRY: RetryPolicy = {
  timeoutMs: config.network.panoTimeoutMs,
  retries: config.network.retries,
  retryDelayMs: config.network.retryDelayMs,
};

/** What the browser reports about connection and memory, for the starting quality tier. */
function deviceHints(): { saveData?: boolean; effectiveType?: string; deviceMemoryGb?: number } {
  if (typeof navigator === 'undefined') return {};
  const n = navigator as Navigator & {
    connection?: { saveData?: boolean; effectiveType?: string };
    deviceMemory?: number;
  };
  return { saveData: n.connection?.saveData, effectiveType: n.connection?.effectiveType, deviceMemoryGb: n.deviceMemory };
}

/**
 * Production pano stage (Track B). One inside-out sphere, centred on the eye every frame,
 * holding the current and past panoramas and the lens mask. At most two panorama textures
 * live at once (`config.texture.maxLive`), counted by a ledger.
 */
export class ProductionPanoStage implements PanoStage {
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

  /** Dev only: hold the black frame this long during a hop (to capture it). */
  debugHoldBlackMs = 0;

  readonly ledger = new TextureLedger<Texture>(config.texture.maxLive);
  private cur: Slot | null = null;
  private past: Slot | null = null;
  private readonly showGate = new LatestOnly();
  private readonly pastGate = new LatestOnly();
  private readonly refitGate = new LatestOnly();
  private readonly fader = new Fader(1);
  private wantVisible = false;
  private mode: Mode = 'table';
  private hopping = false;
  private arrowSeq = 0;

  private readonly material: ShaderMaterial;
  private readonly sphere: Mesh;
  private readonly blank: DataTexture;
  private readonly rootEntity: Entity;
  private readonly arrows: HopArrows;
  private readonly headPos = new Vector3();
  private readonly eyePos = new Vector3();
  private lastFrame = -1;
  private readonly offs: Unsubscribe[] = [];
  private readonly onSessionStart = () => {
    this.governor.resetTiming();
    this.refitCurrent();
  };
  private readonly onSessionEnd = () => this.governor.resetTiming();
  /** Steps panorama detail down when frames run slow, or after the GPU context was lost. */
  readonly governor = new FrameGovernor(initialTier(deviceHints()));
  private readonly onContextLost = (e: Event) => {
    // Ask the browser to give the context back, and come back smaller: running out of GPU
    // memory is the usual reason a headset drops the context.
    e.preventDefault();
    this.governor.forceTier(this.governor.tier + 1, now());
    console.warn('[pano] WebGL context lost; quality tier now', this.governor.tier);
  };
  private readonly onContextRestored = () => {
    // three.js re-creates GPU state; re-upload the current panorama at the new, lower cap.
    this.refitCurrent();
    this.bus.emit('error', {
      source: 'pano',
      message: 'The headset ran short of graphics memory. Showing panoramas at lower detail.',
      recoverable: true,
    });
  };

  constructor(
    private readonly world: World,
    private readonly bus: EventBus,
    private readonly source: PanoSource,
    private readonly deps: LoaderDeps = browserLoaderDeps(),
  ) {
    this.root.name = 'PanoStage';
    this.blank = new DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, RGBAFormat);
    this.blank.needsUpdate = true;

    this.material = new ShaderMaterial({
      vertexShader: STAGE_VERT,
      fragmentShader: STAGE_FRAG,
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
        uFade: { value: 1 },
        uMaxWarp: { value: config.lens.maxDistortion },
        uLensDir: { value: this.lens.direction },
      },
    });
    this.sphere = new Mesh(new SphereGeometry(config.sphereRadiusM, 64, 32), this.material);
    this.sphere.name = 'PanoSphere';
    this.sphere.frustumCulled = false;
    this.sphere.renderOrder = -1000;
    this.sphere.visible = false;
    this.sphere.onBeforeRender = (renderer, _scene, camera) =>
      this.beforeRender(renderer.info.render.frame, camera);
    this.root.add(this.sphere);

    this.rootEntity = world.createTransformEntity(this.root, { persistent: true });
    this.rootEntity.addComponent(PanoSphereTag, { slot: 'stage', value: 0 });
    this.arrows = new HopArrows(world, this.rootEntity, (pano) => this.hopTo(pano));

    this.offs.push(
      bus.on('mode:changed', ({ mode }) => {
        this.mode = mode;
        this.syncArrows();
      }),
    );
    world.renderer.xr.addEventListener('sessionstart', this.onSessionStart);
    world.renderer.xr.addEventListener('sessionend', this.onSessionEnd);
    if (this.governor.tier > 0) {
      console.info(`[pano] starting at quality tier ${this.governor.tier} (Data Saver, slow network or low memory)`);
    }
    world.renderer.domElement.addEventListener('webglcontextlost', this.onContextLost);
    world.renderer.domElement.addEventListener('webglcontextrestored', this.onContextRestored);
  }

  // ------------------------------------------------------------------------------------------
  // PanoStage
  // ------------------------------------------------------------------------------------------

  get currentPano(): Pano | null {
    return this.cur?.pano ?? null;
  }

  get currentTexture(): Texture | null {
    return this.cur?.tex ?? null;
  }

  textureCount(): number {
    return this.ledger.count;
  }

  setVisible(visible: boolean): void {
    this.wantVisible = visible;
    const show = visible && this.cur !== null;
    if (show && !this.sphere.visible) {
      // Appearing from the table: start black and fade in, never pop.
      this.fader.set(0);
      this.fader.fadeTo(1, config.hop.fadeInMs, now());
    }
    this.sphere.visible = show;
    this.syncArrows();
  }

  /**
   * Fade to black, switch, fade in. Loads the 2048 preview and the capped full image in
   * parallel; whichever is ready first goes on screen, the full image replaces the preview
   * later with no fade. A newer `show` cancels this one (it then resolves without emitting).
   */
  async show(pano: Pano): Promise<void> {
    const ticket = this.showGate.begin();
    this.refitGate.cancel();
    this.clearPast();
    const onScreen = this.sphere.visible && this.cur !== null;
    this.hopping = true;
    this.syncArrows();
    const fadeOut = onScreen ? config.hop.fadeOutMs : 0;
    if (onScreen) this.fader.fadeTo(0, fadeOut, now());
    const fadeDone = sleep(fadeOut);

    const fullSize = this.sizeFor(pano, 'current');
    const fullP = loadBitmap(pano.imageUrl, fullSize, ticket.signal, this.deps, PANO_RETRY);
    const previewUrl = pano.previewUrl && pano.previewUrl !== pano.imageUrl ? pano.previewUrl : null;
    const prevP = previewUrl && fullSize.width > widthCap('preview', this.isHeadset(), this.governor.tier)
      ? loadBitmap(previewUrl, this.previewSize(), ticket.signal, this.deps, PANO_RETRY)
      : null;
    // Never leave an unhandled rejection or an unclosed bitmap behind.
    fullP.catch(() => undefined);
    prevP?.catch(() => undefined);

    let first: { key: 'a'; value: ImageBitmap } | { key: 'b'; value: ImageBitmap };
    try {
      first = await firstSuccess(prevP, fullP);
    } catch (err) {
      if (!ticket.current) return;
      this.hopping = false;
      await fadeDone;
      if (this.cur) this.fader.fadeTo(1, config.hop.fadeInMs, now());
      this.syncArrows();
      throw isAbortError(err) ? abortError() : err;
    }
    const gotFull = first.key === 'b';
    if (gotFull) prevP?.then((b) => b.close(), () => undefined);

    await fadeDone;
    if (this.debugHoldBlackMs > 0) await sleep(this.debugHoldBlackMs);
    if (!ticket.current) {
      first.value.close();
      if (!gotFull) fullP.then((b) => b.close(), () => undefined);
      return;
    }

    this.setCurrent(pano, first.value);
    if (!this.wantVisible) this.fader.set(1);
    else {
      if (!onScreen) this.fader.set(0);
      this.sphere.visible = true;
      this.fader.fadeTo(1, config.hop.fadeInMs, now());
    }
    this.hopping = false;
    this.bus.emit('pano:shown', { pano });
    this.refreshArrows(pano);

    if (!gotFull) {
      fullP.then(
        (bitmap) => {
          if (!ticket.current || this.cur?.pano !== pano) return bitmap.close();
          this.setCurrent(pano, bitmap); // same picture, sharper: no fade
        },
        (err) => {
          if (!isAbortError(err)) console.warn('[pano] full image failed, keeping preview', err);
        },
      );
    }
  }

  /**
   * Load a past panorama for the lens. Rejects with an `AbortError` when a newer `loadPast`,
   * `clearPast`, `show` or `commitPast` supersedes it.
   */
  async loadPast(pano: Pano): Promise<Texture> {
    const ticket = this.pastGate.begin();
    const bitmap = await loadBitmap(pano.imageUrl, this.sizeFor(pano, 'past'), ticket.signal, this.deps, PANO_RETRY);
    if (!ticket.current) {
      bitmap.close();
      throw abortError();
    }
    // Free the old past texture before the new one exists: never three live at once.
    this.dropPast();
    const tex = this.makeTexture(bitmap);
    this.past = { tex, bitmap, pano };
    this.lens.pastTexture = tex;
    this.lens.pastHeading = pano.heading;
    return tex;
  }

  commitPast(): void {
    const past = this.past;
    if (!past || this.hopping) return;
    this.showGate.cancel(); // cancels a pending full-size swap of the old pano
    this.pastGate.cancel();
    const old = this.cur;
    this.cur = past;
    this.past = null;
    this.material.uniforms.uCur.value = past.tex;
    this.material.uniforms.uCurHeading.value = MathUtils.degToRad(past.pano.heading);
    if (this.lens.pastTexture === past.tex) this.lens.pastTexture = null;
    this.lens.enabled = false;
    if (old) this.ledger.release(old.tex);
    this.bus.emit('pano:shown', { pano: past.pano });
    this.refreshArrows(past.pano);
    // The past was loaded at the lens cap; upgrade it to the current cap quietly.
    this.refitCurrent();
  }

  clearPast(): void {
    this.pastGate.cancel();
    this.dropPast();
    this.lens.enabled = false;
  }

  dispose(): void {
    this.showGate.cancel();
    this.pastGate.cancel();
    this.refitGate.cancel();
    this.offs.forEach((off) => off());
    this.world.renderer.xr.removeEventListener('sessionstart', this.onSessionStart);
    this.world.renderer.xr.removeEventListener('sessionend', this.onSessionEnd);
    this.world.renderer.domElement.removeEventListener('webglcontextlost', this.onContextLost);
    this.world.renderer.domElement.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.lens.pastTexture = null;
    this.material.uniforms.uCur.value = this.blank;
    this.ledger.releaseAll();
    this.cur = null;
    this.past = null;
    this.arrows.dispose();
    this.sphere.geometry.dispose();
    this.material.dispose();
    this.blank.dispose();
    this.rootEntity.dispose();
  }

  // ------------------------------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------------------------------

  /** Dev/diagnostics snapshot. */
  describe(): Record<string, unknown> {
    const t = now();
    return {
      pano: this.cur?.pano.id ?? null,
      texSize: this.cur ? `${this.cur.bitmap.width}x${this.cur.bitmap.height}` : null,
      pastSize: this.past ? `${this.past.bitmap.width}x${this.past.bitmap.height}` : null,
      textureCount: this.ledger.count,
      maxSeen: this.ledger.maxSeen,
      violations: this.ledger.violations,
      rendererTextures: this.world.renderer.info.memory.textures,
      fade: Number(this.fader.sample(t).toFixed(3)),
      visible: this.sphere.visible,
      mode: this.mode,
      headset: this.isHeadset(),
      maxTextureSize: this.world.renderer.capabilities.maxTextureSize,
      qualityTier: this.governor.tier,
      fps: Math.round(this.governor.fps),
      stencilRef: this.stencilRef,
      arrows: this.arrows.describe(),
    };
  }

  private isHeadset(): boolean {
    if (this.world.session) return true;
    return typeof navigator !== 'undefined' && /OculusBrowser|Quest/i.test(navigator.userAgent);
  }

  private sizeFor(pano: Pano, kind: TextureKind): TextureSize {
    return textureSizeFor(
      pano.width,
      pano.height,
      widthCap(kind, this.isHeadset(), this.governor.tier),
      this.world.renderer.capabilities.maxTextureSize,
    );
  }

  private previewSize(): TextureSize {
    const w = widthCap('preview', this.isHeadset(), this.governor.tier);
    // thumb_2048 is already 2048 wide; ask for exactly that (a no-op resize on desktop).
    return textureSizeFor(0, 0, w, this.world.renderer.capabilities.maxTextureSize);
  }

  private makeTexture(bitmap: ImageBitmap): Texture {
    const tex = new Texture(bitmap as unknown as HTMLImageElement);
    tex.colorSpace = SRGBColorSpace;
    tex.flipY = false; // ignored for ImageBitmap anyway; the shader flips v instead
    tex.generateMipmaps = false;
    tex.minFilter = LinearFilter;
    tex.magFilter = LinearFilter;
    tex.needsUpdate = true;
    // Free order: stop using it (callers swap the uniform first), dispose, close the bitmap.
    this.ledger.track(tex, () => {
      tex.dispose();
      bitmap.close();
    });
    return tex;
  }

  /** Replace the current panorama. Frees the old texture BEFORE creating the new one. */
  private setCurrent(pano: Pano, bitmap: ImageBitmap): void {
    const old = this.cur;
    if (old) {
      this.material.uniforms.uCur.value = this.blank;
      this.ledger.release(old.tex);
    }
    const tex = this.makeTexture(bitmap);
    this.cur = { tex, bitmap, pano };
    this.material.uniforms.uCur.value = tex;
    this.material.uniforms.uCurHeading.value = MathUtils.degToRad(pano.heading);
  }

  private dropPast(): void {
    const past = this.past;
    if (!past) return;
    if (this.lens.pastTexture === past.tex) this.lens.pastTexture = null;
    this.material.uniforms.uPast.value = this.blank;
    this.past = null;
    this.ledger.release(past.tex);
  }

  /** Reload the current panorama at the right cap (after commitPast or entering XR). */
  private refitCurrent(): void {
    const cur = this.cur;
    if (!cur || this.hopping) return;
    const ticket = this.refitGate.begin();
    const size = this.sizeFor(cur.pano, 'current');
    if (size.width === cur.bitmap.width) return;
    const pano = cur.pano;
    loadBitmap(pano.imageUrl, size, ticket.signal, this.deps, PANO_RETRY).then(
      (bitmap) => {
        if (!ticket.current || this.cur?.pano !== pano) return bitmap.close();
        this.setCurrent(pano, bitmap);
      },
      (err) => {
        if (!isAbortError(err)) console.warn('[pano] refit failed', err);
      },
    );
  }

  /** Frames ran slow for a while: reload the panorama on screen at the lower cap. */
  private onTierDropped(): void {
    console.warn(`[pano] frames slow (${Math.round(this.governor.fps)} fps); quality tier now ${this.governor.tier}`);
    this.refitCurrent();
  }

  private hopTo(pano: Pano): void {
    if (this.hopping) return;
    this.show(pano).catch((err) => {
      if (isAbortError(err)) return;
      this.bus.emit('error', { source: 'pano', message: `Could not load that view: ${String(err)}`, recoverable: true });
    });
  }

  private refreshArrows(pano: Pano): void {
    const seq = ++this.arrowSeq;
    this.arrows.clear();
    this.source.neighbours(pano).then(
      (list) => {
        if (seq !== this.arrowSeq || this.cur?.pano !== pano) return;
        this.arrows.setTargets(pickArrowTargets(pano, list, MAX_ARROWS, ARROW_MIN_SEPARATION_DEG));
        this.syncArrows();
      },
      (err) => console.warn('[pano] neighbours failed', err),
    );
  }

  private syncArrows(): void {
    this.arrows.setShown(
      this.sphere.visible && this.mode === 'street' && !this.hopping && this.fader.target === 1,
    );
  }

  private beforeRender(frame: number, camera: Camera): void {
    const m = this.material;
    // Per eye: centre the sphere on THIS eye so both eyes see the panorama at infinity.
    this.eyePos.setFromMatrixPosition(camera.matrixWorld);
    this.sphere.position.copy(this.eyePos);
    this.sphere.updateMatrixWorld();

    if (frame !== this.lastFrame) {
      this.lastFrame = frame;
      // Once per frame: the head (not an eye) drives the floor arrows.
      this.headPos.setFromMatrixPosition(this.world.camera.matrixWorld);
      this.arrows.follow(this.headPos.x, this.headPos.z);
      this.syncArrows();
      // Judge frame rate only in a session: that is where 72 Hz matters, and a desktop tab
      // in the background or on a slow monitor must not lower detail for a later session.
      // Trust the session's reported rate only on a real headset browser: the desktop
      // emulator reports 72-90 Hz while the page actually renders at the monitor's rate.
      const session = this.world.session as (XRSession & { frameRate?: number }) | undefined;
      const hz = ON_HEADSET_BROWSER ? session?.frameRate : undefined;
      if (session && this.governor.frame(now(), hz)) this.onTierDropped();
    }

    const l = this.lens;
    const pastOn = l.enabled && l.pastTexture !== null;
    m.uniforms.uPast.value = l.pastTexture ?? this.blank;
    m.uniforms.uPastOn.value = pastOn ? 1 : 0;
    m.uniforms.uPastHeading.value = MathUtils.degToRad(l.pastHeading);
    m.uniforms.uRadius.value = l.radius;
    m.uniforms.uFeather.value = l.feather;
    m.uniforms.uTime.value = l.time;
    m.uniforms.uFade.value = this.fader.sample(now());

    if (this.stencilRef === null) {
      m.stencilWrite = false;
    } else {
      // In three.js `stencilWrite` is what ENABLES the stencil test. Write mask 0 = never
      // modify the buffer; draw only where it equals stencilRef (Track E's mask, order -2000).
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
}
