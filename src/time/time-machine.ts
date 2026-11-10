import { Vector3 } from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import { config } from '../config.js';
import { yearOf } from '../contracts.js';
import type { Pano, TrackContext, Unsubscribe } from '../contracts.js';
import { TimeLensTag } from '../track-components.js';
import { TIME } from './constants.js';
import { rimOpacity } from './curves.js';
import { smoothDirection, smoothingAlpha } from './lens-math.js';
import { LensMachine } from './machine.js';
import type { LensPhase } from './machine.js';
import { LensRim } from './rim.js';
import { sortedYears } from './years.js';

const DEV = import.meta.env.DEV;

/**
 * Glue between the pure lens state machine, the event bus and the stage. Owns no input:
 * `TimeLensSystem` samples hands, mouse and keys and calls `frame()` once per frame.
 */
export class TimeMachine {
  readonly machine = new LensMachine({
    radius: config.lens.defaultRadius,
    openRippleMs: config.lens.openRippleMs,
    pushThroughMs: config.lens.pushThroughMs,
    maxDistortion: config.lens.maxDistortion,
    pushHoldMs: TIME.pushHoldMs,
    retractSpeed: TIME.retractSpeed,
    closeMs: TIME.closeMs,
    archiveFloorYear: TIME.archiveFloorYear,
  });
  /** Highest `stage.textureCount()` seen. Must never exceed `config.texture.maxLive`. */
  maxTexturesSeen = 0;

  private readonly rim = new LensRim();
  private readonly rimEntity: Entity;
  private readonly probeEntity: Entity;
  private readonly offs: Unsubscribe[] = [];
  /** TIME MACHINE button state, as last told by `time:toggled`. */
  private on: boolean;
  private yearMap = new Map<number, Pano>();
  private yearsToken = 0;
  /** Id of the panorama now in `stage.lens.pastTexture`, or null. */
  private loadedId: string | null = null;
  private wanted: Pano | null = null;
  private loading = false;
  private committing = false;
  private snapDirection = true;
  private lastPhase: LensPhase = 'off';
  private lastYear: number | null = null;
  private disposed = false;

  constructor(private readonly ctx: TrackContext) {
    const { bus, state, world, services } = ctx;
    this.on = state.get().timeOn;

    this.rimEntity = world.createTransformEntity(this.rim.mesh, { persistent: true });
    this.rimEntity.addComponent(TimeLensTag, { slot: 'off', value: 0 });
    // Second marker entity so tools can read live numbers: slot "textures", value = count.
    this.probeEntity = world.createTransformEntity(undefined, { persistent: true });
    this.probeEntity.addComponent(TimeLensTag, { slot: 'textures', value: 0 });

    this.offs.push(
      bus.on('pano:shown', ({ pano }) => void this.onPanoShown(pano)),
      bus.on('time:toggled', ({ on }) => {
        this.on = on;
        this.refresh();
      }),
      bus.on('mode:changed', () => this.refresh()),
    );

    if (services.stage.currentPano) void this.onPanoShown(services.stage.currentPano);
  }

  // -------------------------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------------------------

  private async onPanoShown(pano: Pano): Promise<void> {
    const { bus, services } = this.ctx;
    const token = ++this.yearsToken;
    // A new panorama is on screen: whatever the lens held belongs to the old one.
    this.machine.clearYears();
    this.yearMap.clear();
    this.loadedId = null;
    this.wanted = null;
    if (!this.committing && services.stage.lens.pastTexture) services.stage.clearPast();

    const current = yearOf(pano);
    let found: Map<number, Pano>;
    try {
      found = await services.source.yearsAt(pano.lat, pano.lng);
    } catch (err) {
      found = new Map();
      bus.emit('error', { source: 'time', message: `Could not look up other years: ${String(err)}`, recoverable: true });
    }
    if (token !== this.yearsToken || this.disposed) return; // a newer panorama arrived meanwhile

    this.yearMap = found;
    const years = sortedYears([...found.keys(), current]);
    bus.emit('time:yearsKnown', { years, earliest: years[0] ?? null });
    if (this.machine.setYears(years, current)) this.onOpened();
    else this.refresh();
  }

  /** Bring the machine in line with the button and the mode. */
  private refresh(): void {
    const { state, services } = this.ctx;
    const mode = state.get().mode;
    if (mode === 'table') {
      // The flow already cleared the past texture; just drop the lens with no animation.
      this.machine.wantOn = false;
      if (this.machine.phase !== 'off') this.machine.reset();
      if (services.stage.lens.pastTexture) services.stage.clearPast();
      this.loadedId = null;
      this.wanted = null;
      return;
    }
    if (this.on) {
      if (this.machine.toggle(true)) this.onOpened();
    } else {
      this.machine.toggle(false);
    }
  }

  private onOpened(): void {
    const year = this.machine.year;
    if (year === null) return;
    this.snapDirection = true;
    this.ctx.bus.emit('time:yearChanged', { year });
    this.requestPast();
  }

  // -------------------------------------------------------------------------------------------
  // Past panorama loading: one at a time, newest request wins
  // -------------------------------------------------------------------------------------------

  private requestPast(): void {
    const year = this.machine.year;
    const pano = year === null ? undefined : this.yearMap.get(year);
    if (!pano || !this.machine.yearHasPano) {
      // Archive stop: no panorama for this year, so nothing to load (Track F takes over).
      this.wanted = null;
      this.machine.pastReady = false;
      return;
    }
    if (this.loadedId === pano.id) {
      this.wanted = null;
      this.machine.pastReady = true;
      return;
    }
    this.wanted = pano;
    if (!this.loading) void this.pump();
  }

  private async pump(): Promise<void> {
    const { bus, services } = this.ctx;
    this.loading = true;
    bus.emit('loading', { scope: 'time', busy: true });
    try {
      while (this.wanted) {
        const pano = this.wanted;
        this.wanted = null;
        try {
          await services.stage.loadPast(pano);
        } catch (err) {
          bus.emit('error', { source: 'time', message: `Could not load ${yearOf(pano)}: ${String(err)}`, recoverable: true });
          continue;
        }
        if (this.disposed) return;
        if (!this.machine.isActive) {
          // The lens closed while this was loading: do not keep a texture nobody sees.
          if (!this.wanted) services.stage.clearPast();
          this.loadedId = null;
          continue;
        }
        this.loadedId = pano.id;
        const now = this.machine.year === null ? undefined : this.yearMap.get(this.machine.year);
        this.machine.pastReady = now?.id === pano.id;
      }
    } finally {
      this.loading = false;
      bus.emit('loading', { scope: 'time', busy: false });
    }
  }

  private commit(): void {
    const { bus, services } = this.ctx;
    const year = this.machine.year;
    const pano = year === null ? undefined : this.yearMap.get(year);
    this.on = false;
    this.machine.wantOn = false;
    if (year === null || !pano) return;
    services.stage.lens.radius = Math.PI;
    this.committing = true;
    try {
      services.stage.commitPast(); // emits pano:shown, which resets the years
    } finally {
      this.committing = false;
    }
    services.stage.lens.radius = config.lens.defaultRadius;
    this.loadedId = null;
    bus.emit('time:committed', { year, pano });
  }

  // -------------------------------------------------------------------------------------------
  // Per frame. No allocation below this line.
  // -------------------------------------------------------------------------------------------

  /**
   * @param dtSec     frame time, seconds
   * @param timeSec   running clock, seconds (drives shimmer)
   * @param head      world position of the viewer's head
   * @param target    unit vector from the head toward the hand (or through the mouse)
   * @param pushHeld  lens hand pinching / trigger held / Space held
   * @param dialHeld  dial hand pinching
   * @param yearDelta whole dial steps this frame (negative is earlier)
   */
  frame(
    dtSec: number,
    timeSec: number,
    head: Vector3,
    target: Vector3,
    pushHeld: boolean,
    dialHeld: boolean,
    yearDelta: number,
  ): void {
    const m = this.machine;
    const stage = this.ctx.services.stage;
    const lens = stage.lens;
    const dtMs = dtSec * 1000;

    if (yearDelta !== 0 && m.step(yearDelta)) {
      this.ctx.bus.emit('time:yearChanged', { year: m.year as number });
      this.requestPast();
    }

    const signal = m.update(dtMs, pushHeld, dialHeld);
    if (signal === 'commit') {
      this.commit();
    } else if (signal === 'closed') {
      this.wanted = null;
      this.loadedId = null;
      if (lens.pastTexture || lens.enabled) stage.clearPast();
    }

    if (m.isActive) {
      if (this.snapDirection) {
        lens.direction.copy(target);
        this.snapDirection = false;
      } else if (m.followsHand) {
        smoothDirection(lens.direction, target, smoothingAlpha(dtMs, TIME.directionSmoothingMs));
      }
      lens.radius = m.radius;
      lens.feather = config.lens.feather;
      lens.time = timeSec;
      // Show the past only when the texture on the stage belongs to this spot. While a newly
      // dialled year loads, the previous year stays visible rather than flashing the present.
      lens.enabled = lens.pastTexture !== null && this.loadedId !== null && m.yearHasPano;
      this.rim.update(
        head,
        lens.direction,
        m.radius,
        rimOpacity(m.radius, TIME.rimFadeStartRad),
        m.ripple,
        timeSec,
        !m.yearHasPano,
        stage.stencilRef,
      );
    } else {
      if (lens.enabled) lens.enabled = false;
      this.rim.hide();
    }

    const textures = stage.textureCount();
    if (textures > this.maxTexturesSeen) this.maxTexturesSeen = textures;
    this.publish(textures);
  }

  /** Mirror state into the marker components (only on change) for ECS tools and tests. */
  private publish(textures: number): void {
    const m = this.machine;
    if (m.phase !== this.lastPhase || m.year !== this.lastYear) {
      if (DEV) {
        console.info(
          `[time] ${this.lastPhase} -> ${m.phase} year=${m.year} textures=${textures} max=${this.maxTexturesSeen}`,
        );
      }
      this.lastPhase = m.phase;
      this.lastYear = m.year;
      this.rimEntity.setValue(TimeLensTag, 'slot', m.phase);
      this.rimEntity.setValue(TimeLensTag, 'value', m.year ?? 0);
    }
    if (this.probeEntity.getValue(TimeLensTag, 'value') !== this.maxTexturesSeen) {
      this.probeEntity.setValue(TimeLensTag, 'value', this.maxTexturesSeen);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.offs.forEach((off) => off());
    this.offs.length = 0;
    const stage = this.ctx.services.stage;
    if (stage.lens.pastTexture || stage.lens.enabled) stage.clearPast();
    this.rim.dispose();
    this.rimEntity.dispose();
    this.probeEntity.dispose();
  }
}
