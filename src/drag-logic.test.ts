import { describe, expect, it } from 'vitest';
import { DEFAULT_DRAG_LIMITS, PanelPlacements, clampToHead, yawToward } from './drag-logic.js';

const head = { x: 1, y: 1.6, z: 2 };

describe('clampToHead', () => {
  it('leaves a panel inside the limits alone', () => {
    const p = { x: 1, y: 1.2, z: 0.5 };
    expect(clampToHead(p, head, DEFAULT_DRAG_LIMITS, { x: 0, y: 0, z: 0 })).toEqual(p);
  });

  it('pulls a far panel back to the max distance along the same direction', () => {
    const out = clampToHead({ x: 1, y: 1.2, z: -4 }, head, DEFAULT_DRAG_LIMITS, { x: 0, y: 0, z: 0 });
    expect(out.x).toBeCloseTo(1);
    expect(out.z).toBeCloseTo(2 - 3);
    expect(out.y).toBe(1.2);
  });

  it('pushes a too-near panel out and clamps height both ways', () => {
    const near = clampToHead({ x: 1.1, y: 5, z: 2 }, head, DEFAULT_DRAG_LIMITS, { x: 0, y: 0, z: 0 });
    expect(Math.hypot(near.x - head.x, near.z - head.z)).toBeCloseTo(0.5);
    expect(near.y).toBe(2.2);
    expect(clampToHead({ x: 3, y: -1, z: 2 }, head, DEFAULT_DRAG_LIMITS, { x: 0, y: 0, z: 0 }).y).toBe(0.3);
  });

  it('a panel dropped on the head goes north, and may write in place', () => {
    const p = { x: 1, y: 1, z: 2 };
    expect(clampToHead(p, head, DEFAULT_DRAG_LIMITS, p)).toBe(p);
    expect(p).toEqual({ x: 1, y: 1, z: 1.5 });
  });
});

describe('yawToward', () => {
  it('turns +Z at the head', () => {
    expect(yawToward({ x: 0, y: 0, z: -2 }, { x: 0, y: 0, z: 0 })).toBeCloseTo(0); // head is toward +Z
    expect(yawToward({ x: -2, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })).toBeCloseTo(Math.PI / 2);
    expect(Math.abs(yawToward({ x: 0, y: 0, z: 2 }, { x: 0, y: 0, z: 0 }))).toBeCloseTo(Math.PI);
    expect(yawToward({ x: 0, y: 3, z: 0 }, { x: 0, y: 0, z: 0 })).toBe(0);
  });
});

describe('PanelPlacements', () => {
  it('remembers, updates in place and forgets', () => {
    const p = new PanelPlacements();
    expect(p.has('search')).toBe(false);
    p.set('search', { x: 1, y: 2, z: 3 }, 0.5);
    const first = p.get('search');
    p.set('search', { x: 4, y: 5, z: 6 }, 1);
    expect(p.get('search')).toBe(first);
    expect(p.get('search')).toEqual({ x: 4, y: 5, z: 6, yaw: 1 });
    p.set('places', { x: 0, y: 0, z: 0 }, 0);
    expect(p.size).toBe(2);
    p.delete('places');
    expect(p.has('places')).toBe(false);
    p.set('archive-0', { x: 0, y: 0, z: 0 }, 0);
    p.set('archive-1', { x: 0, y: 0, z: 0 }, 0);
    p.deletePrefix('archive-');
    expect(p.size).toBe(1);
    p.clear();
    expect(p.size).toBe(0);
  });
});
