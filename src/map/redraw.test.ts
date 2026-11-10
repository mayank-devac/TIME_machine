import { describe, expect, it } from 'vitest';
import { RedrawScheduler } from './redraw.js';

describe('RedrawScheduler', () => {
  it('redraws once at start, then only when dirty', () => {
    const s = new RedrawScheduler(33, 150);
    expect(s.due(0)).toBe(true);
    expect(s.due(100)).toBe(false);
    expect(s.due(1000)).toBe(false);
    s.markDirty();
    expect(s.due(1001)).toBe(true);
    expect(s.count).toBe(2);
  });

  it('limits redraws while panning to the active interval', () => {
    const s = new RedrawScheduler(33, 150);
    s.due(0);
    s.markDirty();
    expect(s.due(10)).toBe(false);
    expect(s.isDirty).toBe(true);
    expect(s.due(40)).toBe(true);
  });

  it('keeps redrawing slowly while tiles are pending', () => {
    const s = new RedrawScheduler(33, 150);
    s.due(0);
    s.setPending(true);
    expect(s.due(100)).toBe(false);
    expect(s.due(160)).toBe(true);
    expect(s.due(200)).toBe(false);
    expect(s.due(320)).toBe(true);
    s.setPending(false);
    expect(s.due(1000)).toBe(false);
  });
});
