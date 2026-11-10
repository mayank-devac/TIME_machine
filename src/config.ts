/**
 * Budgets and constants. Phase 0 / orchestrator only. Tracks import from here, never inline
 * a number that appears below. Values marked UNTESTED have not been tried on a headset.
 */

export const config = {
  /** Mapillary search radius cap is 50 m. */
  searchRadiusM: 50,
  /** Skip a year whose nearest panorama is farther than this from the spot. */
  maxYearOffsetMetres: 40,
  /** Minimum gap between Mapillary search requests, ms. Tile quota is 50,000/day. */
  minRequestIntervalMs: 120,

  texture: {
    /** Width caps for the panorama texture. UNTESTED on device. */
    currentMaxWidthDesktop: 8192,
    currentMaxWidthHeadset: 5760,
    pastMaxWidth: 4096,
    /** Hard cap on live panorama textures (current + past). */
    maxLive: 2,
  },

  hop: {
    fadeOutMs: 200,
    fadeInMs: 200,
  },

  lens: {
    /** Angular radius in radians (about 14 degrees). */
    defaultRadius: 0.25,
    feather: 0.05,
    openRippleMs: 700,
    pushThroughMs: 1600,
    /** Max view-direction warp near the rim, radians. Keep tiny; large warps cause discomfort. */
    maxDistortion: 0.02,
  },

  map: {
    tableSizeM: 0.9,
    tableHeightM: 0.85,
    canvasPx: 2048,
    defaultZoom: 15,
  },

  portal: {
    windowWidthM: 1.0,
    windowHeightM: 1.2,
    stencilRef: 1,
  },

  performance: {
    maxDrawCalls: 100,
    targetHz: 72,
  },

  /** Where the stage sphere sits relative to the head. Far enough to read as infinitely distant. */
  sphereRadiusM: 50,
} as const;

export type Config = typeof config;
