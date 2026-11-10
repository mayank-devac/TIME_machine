import { describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { EventBus, createAppState } from '../contracts.js';
import type { Mode } from '../contracts.js';
import { PortalFlow, REQUEST_TIMEOUT_MS } from './portal-flow.js';
import type { StageLike } from './portal-flow.js';
import { CrossingDetector, placeInFrontOfHead, segmentHitsOpening, signedDistance } from './portal-logic.js';
import type { Placement, WindowPlane } from './portal-logic.js';

const v = (x: number, y: number, z: number) => ({ x, y, z });

/** A 1.0 x 1.2 window at z = -1.3, centre y = 1.45, facing +Z (toward a viewer at the origin). */
function plane(): WindowPlane {
  return {
    origin: v(0, 1.45, -1.3),
    normal: v(0, 0, 1),
    right: v(1, 0, 0),
    up: v(0, 1, 0),
    halfWidth: 0.5,
    halfHeight: 0.6,
  };
}

const HEAD = { roomMargin: 0.1, streetDepth: 0.05, inset: 0.05 };
const HAND = { roomMargin: 0.05, streetDepth: 0.12, inset: 0.08 };

describe('plane maths', () => {
  it('signed distance is positive in the room and negative in the street', () => {
    expect(signedDistance(plane(), v(0, 1.6, 0))).toBeCloseTo(1.3);
    expect(signedDistance(plane(), v(0, 1.6, -2))).toBeCloseTo(-0.7);
  });

  it('segment through the opening hits, around the frame misses', () => {
    expect(segmentHitsOpening(plane(), v(0, 1.6, 0), v(0, 1.6, -2))).toBe(true);
    expect(segmentHitsOpening(plane(), v(0.8, 1.6, 0), v(0.8, 1.6, -2))).toBe(false); // beside
    expect(segmentHitsOpening(plane(), v(0, 2.2, 0), v(0, 2.2, -2))).toBe(false); // above
    expect(segmentHitsOpening(plane(), v(0.47, 1.6, 0), v(0.47, 1.6, -2), 0.05)).toBe(false); // inset
  });
});

describe('head crossing', () => {
  it('fires once when the head walks through the opening', () => {
    const d = new CrossingDetector(HEAD);
    const p = plane();
    const fired: boolean[] = [];
    for (let z = 0; z >= -2; z -= 0.05) fired.push(d.update(p, v(0, 1.6, z)));
    expect(fired.filter(Boolean)).toHaveLength(1);
  });

  it('fires when teleported through in one frame', () => {
    const d = new CrossingDetector(HEAD);
    const p = plane();
    expect(d.update(p, v(0, 1.6, 0))).toBe(false);
    expect(d.update(p, v(0, 1.6, -2))).toBe(true);
  });

  it('does not fire when walking around the frame', () => {
    const d = new CrossingDetector(HEAD);
    const p = plane();
    d.update(p, v(0, 1.6, 0));
    d.update(p, v(1.2, 1.6, -0.5));
    expect(d.update(p, v(1.2, 1.6, -2))).toBe(false);
    expect(d.update(p, v(0, 1.6, -2))).toBe(false); // behind the window, not through it
  });

  it('does not fire when starting on the street side or walking back out', () => {
    const d = new CrossingDetector(HEAD);
    const p = plane();
    expect(d.update(p, v(0, 1.6, -2))).toBe(false);
    expect(d.update(p, v(0, 1.6, 0))).toBe(false);
  });

  it('needs re-arming after reset', () => {
    const d = new CrossingDetector(HEAD);
    const p = plane();
    d.update(p, v(0, 1.6, 0));
    d.reset();
    expect(d.update(p, v(0, 1.6, -2))).toBe(false);
  });

  it('hovering inside the dead band does not fire', () => {
    const d = new CrossingDetector(HEAD);
    const p = plane();
    d.update(p, v(0, 1.6, 0));
    expect(d.update(p, v(0, 1.6, -1.32))).toBe(false); // 2 cm through, < streetDepth
    expect(d.update(p, v(0, 1.6, -1.4))).toBe(true);
  });
});

describe('hand push', () => {
  it('a push 12+ cm through the opening fires', () => {
    const d = new CrossingDetector(HAND);
    const p = plane();
    d.update(p, v(0.1, 1.3, -1.0));
    expect(d.update(p, v(0.1, 1.3, -1.35))).toBe(false); // 5 cm through: not yet
    expect(d.update(p, v(0.1, 1.3, -1.45))).toBe(true);
  });

  it('a hand holding the frame edge does not fire', () => {
    const d = new CrossingDetector(HAND);
    const p = plane();
    d.update(p, v(0.48, 1.3, -1.2));
    expect(d.update(p, v(0.48, 1.3, -1.5))).toBe(false); // inside the 8 cm inset
  });
});

describe('placement in front of the head', () => {
  const out = (): Placement => ({ position: v(0, 0, 0), yaw: 0 });

  it('looking north puts the window north, facing back south at the head', () => {
    const r = placeInFrontOfHead(v(0, 1.6, 0), v(0, -0.3, -1), 1.3, 0.15, out());
    expect(r.position.x).toBeCloseTo(0);
    expect(r.position.y).toBeCloseTo(1.45);
    expect(r.position.z).toBeCloseTo(-1.3);
    // normal = (sin yaw, cos yaw) must point at the head (+Z)
    expect(Math.sin(r.yaw)).toBeCloseTo(0);
    expect(Math.cos(r.yaw)).toBeCloseTo(1);
  });

  it('looking east puts it east, normal pointing west', () => {
    const r = placeInFrontOfHead(v(1, 1.7, 2), v(1, 0, 0), 1.3, 0.15, out());
    expect(r.position.x).toBeCloseTo(2.3);
    expect(r.position.z).toBeCloseTo(2);
    expect(Math.sin(r.yaw)).toBeCloseTo(-1);
  });

  it('looking straight down falls back to north', () => {
    const r = placeInFrontOfHead(v(0, 1.6, 0), v(0, -1, 0), 1.3, 0.15, out());
    expect(r.position.z).toBeCloseTo(-1.3);
  });
});

/** Fake stage plus a stand-in for the orchestrator flow (accept every request synchronously). */
function rig(initial: Mode = 'table', accept = true) {
  const bus = new EventBus();
  const state = createAppState(bus);
  const visible: boolean[] = [];
  const stage: StageLike = { stencilRef: null, setVisible: (on) => visible.push(on) };
  const requested: Mode[] = [];
  let t = 0;
  bus.on('mode:requested', ({ mode }) => {
    requested.push(mode);
    if (!accept) return;
    const previous = state.get().mode;
    if (previous !== mode) bus.emit('mode:changed', { mode, previous });
  });
  if (initial !== 'table') bus.emit('mode:changed', { mode: initial, previous: 'table' });
  const opened: number[] = [];
  const closed: number[] = [];
  const flow = new PortalFlow(
    bus,
    stage,
    state.get().mode,
    { onOpen: () => opened.push(t), onClose: () => closed.push(t) },
    () => t,
  );
  return { bus, state, stage, flow, requested, opened, closed, visible, tick: (ms: number) => (t += ms) };
}

describe('mode state machine and stencil', () => {
  it('portal mode sets stencilRef and opens; leaving clears it and closes', () => {
    const r = rig('street');
    expect(r.stage.stencilRef).toBeNull();
    expect(r.flow.requestPortal()).toBe(true);
    expect(r.state.get().mode).toBe('portal');
    expect(r.stage.stencilRef).toBe(config.portal.stencilRef);
    expect(r.opened).toHaveLength(1);
    expect(r.flow.enterStreet('head')).toBe(true);
    expect(r.state.get().mode).toBe('street');
    expect(r.stage.stencilRef).toBeNull();
    expect(r.closed).toHaveLength(1);
    expect(r.flow.lastEnterReason).toBe('head');
  });

  it('exit to room requests table and clears the stencil', () => {
    const r = rig('portal');
    expect(r.stage.stencilRef).toBe(config.portal.stencilRef);
    expect(r.flow.exitToRoom()).toBe(true);
    expect(r.requested).toEqual(['table']);
    expect(r.stage.stencilRef).toBeNull();
  });

  it('mode changes made by others (e.g. Track G buttons) also open and close it', () => {
    const r = rig('street');
    r.bus.emit('mode:changed', { mode: 'portal', previous: 'street' });
    expect(r.stage.stencilRef).toBe(1);
    r.bus.emit('mode:changed', { mode: 'table', previous: 'portal' });
    expect(r.stage.stencilRef).toBeNull();
    expect(r.requested).toEqual([]);
  });

  it('only asks for portal from the street', () => {
    const r = rig('table');
    expect(r.flow.requestPortal()).toBe(false);
    expect(r.flow.enterStreet('press')).toBe(false);
    expect(r.flow.exitToRoom()).toBe(false);
    expect(r.requested).toEqual([]);
  });

  it('never sends a duplicate while a request is unanswered, then retries after the timeout', () => {
    const r = rig('portal', false);
    expect(r.flow.enterStreet('head')).toBe(true);
    expect(r.flow.enterStreet('hand')).toBe(false);
    expect(r.flow.exitToRoom()).toBe(false);
    r.tick(REQUEST_TIMEOUT_MS / 2);
    expect(r.flow.enterStreet('press')).toBe(false);
    expect(r.requested).toEqual(['street']);
    r.tick(REQUEST_TIMEOUT_MS);
    expect(r.flow.enterStreet('press')).toBe(true);
    expect(r.requested).toEqual(['street', 'street']);
  });

  it('an answered request clears the block immediately', () => {
    const r = rig('street');
    r.flow.requestPortal();
    expect(r.flow.pendingRequest).toBeNull();
    expect(r.flow.enterStreet('press')).toBe(true);
    expect(r.flow.requests).toBe(2);
  });

  it('dispose while open clears the stencil and stops listening', () => {
    const r = rig('portal');
    r.flow.dispose();
    expect(r.stage.stencilRef).toBeNull();
    r.bus.emit('mode:changed', { mode: 'street', previous: 'portal' });
    expect(r.closed).toHaveLength(0);
  });
});
