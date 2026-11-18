import { describe, expect, it } from "vitest";
import type { Pixel } from "./geo.js";
import {
  PINCH_DEADZONE,
  STALE_POINTER_MS,
  TAP_MAX_MS,
  TableGestures,
  tapSlopPx,
  type GestureSink,
} from "./gestures.js";

const SLOP = 20;

function setup(zoomTarget = 15) {
  const calls: string[] = [];
  const pans: Array<[number, number]> = [];
  const zooms: number[] = [];
  const sink: GestureSink = {
    pan: (_end: Pixel, dx, dy) => {
      calls.push("pan");
      pans.push([dx, dy]);
    },
    zoomTo: (z) => {
      calls.push("zoom");
      zooms.push(z);
    },
    tap: (x, y) => calls.push(`tap ${x},${y}`),
    dropped: (id) => calls.push(`dropped ${id}`),
    zoomTarget: () => zoomTarget,
  };
  return { g: new TableGestures(sink, SLOP), calls, pans, zooms };
}

const at = (x: number, y: number): Pixel => ({ x, y });

describe("tap slop", () => {
  it("is a distance on the table (17 mm), not a share of the canvas", () => {
    expect(tapSlopPx(2048, 1.7)).toBeCloseTo(20.48, 9);
    expect(tapSlopPx(2048, 3.4)).toBeCloseTo(10.24, 9);
  });
});

describe("tap versus drag", () => {
  it("a short, still press is a tap at the release point", () => {
    const { g, calls } = setup();
    g.down(1, at(100, 100), 0);
    g.up(1, 200, false);
    expect(calls).toEqual(["tap 100,100"]);
  });

  it("a wobble inside the slop never pans and still taps, however long the path", () => {
    const { g, calls } = setup();
    g.down(1, at(100, 100), 0);
    for (let i = 0; i < 20; i++)
      g.move(1, at(100 + (i % 2 ? 15 : -15), 100), i * 10);
    g.up(1, 300, false);
    expect(calls).toEqual(["tap 115,100"]);
  });

  it("a slow press is not a tap", () => {
    const { g, calls } = setup();
    g.down(1, at(100, 100), 0);
    g.up(1, TAP_MAX_MS + 1, false);
    expect(calls).toEqual([]);
  });

  it("a cancelled press is not a tap", () => {
    const { g, calls } = setup();
    g.down(1, at(100, 100), 0);
    g.up(1, 100, true);
    expect(calls).toEqual([]);
  });

  it("past the slop it pans, catching up with the whole offset, then follows; no tap", () => {
    const { g, calls, pans } = setup();
    g.down(1, at(100, 100), 0);
    g.move(1, at(110, 100), 10); // inside
    g.move(1, at(130, 100), 20); // crosses: catch up 30
    g.move(1, at(135, 102), 30); // follows: 5, 2
    g.move(1, at(105, 100), 40); // back near the start: still a drag
    g.up(1, 100, false);
    expect(pans).toEqual([
      [30, 0],
      [5, 2],
      [-30, -2],
    ]);
    expect(calls.filter((c) => c.startsWith("tap"))).toEqual([]);
  });
});

describe("pinch", () => {
  it("pans with the midpoint and zooms only past the dead zone, without a jump", () => {
    const { g, pans, zooms } = setup(15);
    g.down(1, at(100, 100), 0);
    g.down(2, at(700, 100), 0);
    // Both slide right by 40, one after the other: pan only (600 -> 560 -> 600 is inside).
    g.move(1, at(140, 100), 10);
    g.move(2, at(740, 100), 20);
    expect(zooms).toEqual([]);
    expect(pans).toEqual([
      [20, 0],
      [20, 0],
    ]);
    // Spread from 600 to 2^(PINCH_DEADZONE + 0.05) * 600: zooming starts here, at 15.
    const spread = 600 * 2 ** (PINCH_DEADZONE + 0.05);
    g.move(2, at(140 + spread, 100), 30);
    expect(zooms).toEqual([15]);
    // Double that spread: +1.
    g.move(2, at(140 + spread * 2, 100), 40);
    expect(zooms[zooms.length - 1]).toBeCloseTo(16, 9);
  });

  it("never taps while or after two pointers were down, until all are up", () => {
    const { g, calls } = setup();
    g.down(1, at(100, 100), 0);
    g.down(2, at(300, 100), 0);
    g.up(2, 50, false);
    g.up(1, 60, false);
    expect(calls).toEqual([]);
    g.down(3, at(100, 100), 100);
    g.up(3, 150, false);
    expect(calls).toEqual(["tap 100,100"]);
  });

  it("one pointer left after a pinch keeps panning", () => {
    const { g, pans } = setup();
    g.down(1, at(100, 100), 0);
    g.down(2, at(300, 100), 0);
    g.up(2, 10, false);
    g.move(1, at(150, 100), 20);
    expect(pans).toEqual([[50, 0]]);
  });
});

describe("lost pointers", () => {
  it("a silent held pointer is dropped when another goes down, so the click still taps", () => {
    const { g, calls } = setup();
    g.down(1, at(500, 500), 0); // its release never arrives
    g.down(2, at(100, 100), STALE_POINTER_MS + 1);
    g.up(2, STALE_POINTER_MS + 100, false);
    expect(calls).toEqual(["dropped 1", "tap 100,100"]);
    expect(g.count).toBe(0);
  });

  it("a recently active pointer is kept: that is a real pinch", () => {
    const { g, calls } = setup();
    g.down(1, at(500, 500), 0);
    g.move(1, at(501, 500), STALE_POINTER_MS);
    g.down(2, at(100, 100), STALE_POINTER_MS + 1);
    expect(g.count).toBe(2);
    expect(calls).toEqual([]);
  });

  it("reset forgets and reports every held pointer", () => {
    const { g, calls } = setup();
    g.down(1, at(100, 100), 0);
    g.down(2, at(300, 100), 0);
    g.reset();
    expect(g.count).toBe(0);
    g.down(3, at(100, 100), 10);
    g.up(3, 20, false);
    expect(calls).toEqual(["dropped 1", "dropped 2", "tap 100,100"]);
  });
});
