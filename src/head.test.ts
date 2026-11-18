import { describe, expect, it } from 'vitest';
import { positionAround, yawFromForward } from './head.js';

describe('yawFromForward', () => {
  it('is 0 looking north (-Z) and +PI/2 looking west (-X)', () => {
    expect(yawFromForward(0, -1)).toBeCloseTo(0);
    expect(yawFromForward(-1, 0)).toBeCloseTo(Math.PI / 2);
  });
  it('reads straight up or down as north', () => {
    expect(yawFromForward(0, 0)).toBe(0);
  });
});

describe('positionAround', () => {
  const out = () => ({ x: 0, y: 0, z: 0 });

  it('puts a zero offset straight ahead at the given distance and height', () => {
    const p = positionAround({ x: 0, y: 1.6, z: 1 }, 0, { leftDeg: 0, distance: 1.5, dy: -0.92 }, out());
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo(0.68);
    expect(p.z).toBeCloseTo(-0.5);
  });

  it('positive leftDeg is to the left, whatever the heading', () => {
    expect(positionAround({ x: 0, y: 1.6, z: 0 }, 0, { leftDeg: 30, distance: 1, dy: 0 }, out()).x).toBeLessThan(0);
    const west = yawFromForward(-1, 0);
    const p = positionAround({ x: 0, y: 1.6, z: 0 }, west, { leftDeg: 0, distance: 1.5, dy: 0 }, out());
    expect(p.x).toBeCloseTo(-1.5);
    expect(p.z).toBeCloseTo(0);
  });
});
