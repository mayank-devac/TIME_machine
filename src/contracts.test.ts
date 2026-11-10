import { describe, expect, it, vi } from 'vitest';
import { EventBus, createAppState, yearOf } from './contracts.js';
import type { Pano } from './contracts.js';

const pano = { id: '1', capturedAt: Date.UTC(2023, 5, 1) } as Pano;

describe('EventBus', () => {
  it('delivers payloads and unsubscribes', () => {
    const bus = new EventBus();
    const fn = vi.fn();
    const off = bus.on('time:toggled', fn);
    bus.emit('time:toggled', { on: true });
    off();
    bus.emit('time:toggled', { on: false });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith({ on: true });
  });

  it('keeps going when a handler throws', () => {
    const bus = new EventBus();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ok = vi.fn();
    bus.on('loading', () => {
      throw new Error('boom');
    });
    bus.on('loading', ok);
    bus.emit('loading', { scope: 'x', busy: true });
    expect(ok).toHaveBeenCalled();
    err.mockRestore();
  });

  it('once fires once', () => {
    const bus = new EventBus();
    const fn = vi.fn();
    bus.once('time:toggled', fn);
    bus.emit('time:toggled', { on: true });
    bus.emit('time:toggled', { on: true });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('createAppState', () => {
  it('folds events into state', () => {
    const bus = new EventBus();
    const store = createAppState(bus);
    bus.emit('pano:shown', { pano });
    bus.emit('time:yearsKnown', { years: [2022, 2025], earliest: 2022 });
    bus.emit('time:toggled', { on: true });
    bus.emit('time:yearChanged', { year: 2022 });
    expect(store.get()).toMatchObject({ timeOn: true, year: 2022, years: [2022, 2025] });
    bus.emit('time:committed', { year: 2022, pano });
    expect(store.get()).toMatchObject({ timeOn: false, year: null });
    bus.emit('mode:changed', { mode: 'street', previous: 'table' });
    expect(store.get().mode).toBe('street');
  });

  it('yearOf uses UTC', () => {
    expect(yearOf(pano)).toBe(2023);
  });
});
