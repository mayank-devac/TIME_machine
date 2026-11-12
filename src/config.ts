/**
 * Budgets and constants. Phase 0 / orchestrator only. Tracks import from here, never inline
 * a number that appears below. Values marked UNTESTED have not been tried on a headset.
 */

export const config = {
  /** Mapillary search radius cap is 50 m. */
  searchRadiusM: 50,
  /** Skip a year whose nearest panorama is farther than this from the spot. */
  maxYearOffsetMetres: 12,
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
    /** Angular radius in radians (about 23 degrees). */
    defaultRadius: 0.4,
    feather: 0.05,
    openRippleMs: 700,
    pushThroughMs: 1600,
    /** Max view-direction warp near the rim, radians. Keep tiny; large warps cause discomfort. */
    maxDistortion: 0.02,
  },

  map: {
    tableSizeM: 1.7,
    tableHeightM: 0.85,
    canvasPx: 2048,
    defaultZoom: 15,
  },

  portal: {
    /** Size of the opening at scale 1. Big enough to step through without ducking. UNTESTED on device. */
    windowWidthM: 1.4,
    windowHeightM: 1.7,
    /** Limits of the corner resize handle (uniform scale of the whole window). */
    minScale: 0.6,
    maxScale: 1.6,
    stencilRef: 1,
  },

  performance: {
    maxDrawCalls: 100,
    targetHz: 72,
  },

  /**
   * Automatic quality fallback. Tier 0 is the normal caps in `texture`; each later tier caps
   * panorama widths lower. The app only ever steps DOWN during a visit (no oscillation).
   * UNTESTED on device: thresholds chosen on paper.
   */
  quality: {
    tiers: [
      { current: 8192, past: 4096 },
      { current: 4096, past: 3072 },
      { current: 3072, past: 2048 },
      { current: 2048, past: 2048 },
    ],
    /** Smoothed frame rate below this fraction of the session's frame rate counts as slow. */
    slowFraction: 0.85,
    /** Slow frames must persist this long before stepping down a tier, ms. */
    slowForMs: 2500,
    /** After a step down, wait this long before judging again (the reload itself costs frames), ms. */
    cooldownMs: 6000,
    /** Ignore frame gaps longer than this (tab hidden, headset off, system menu), ms. */
    maxFrameGapMs: 250,
  },

  network: {
    /**
     * Give up on one panorama image request when no bytes arrive for this long, ms. A stall
     * timer, not a total cap: a slow but moving download (3+ MB over weak Wi-Fi) always finishes.
     */
    panoTimeoutMs: 15000,
    /** Give up on one Mapillary API request after this long, ms. */
    apiTimeoutMs: 12000,
    /** Retries after a network failure or timeout (not after a 4xx). */
    retries: 1,
    retryDelayMs: 800,
  },

  /** Where the stage sphere sits relative to the head. Far enough to read as infinitely distant. */
  sphereRadiusM: 50,
} as const;

export type Config = typeof config;
