# Untested on a headset

Nobody has run this on a Meta Quest. Everything below is unknown until someone does.
Add to this list; do not remove items without a device test.

- Real frame rate (72 Hz target) with the stage sphere, lens shader and map plane.
- GPU memory headroom: whether two 5760-wide panorama textures fit; the real
  `MAX_TEXTURE_SIZE`; behaviour when exceeded.
- Whether Quest Browser composites the opaque sphere over passthrough as the emulator does.
- Whether MapLibre can be redrawn from XR frames during a session (not even proven in the
  emulator; see `docs/spikes.md`).
- Hand-tracking feel: pinch detection noise, wrist-dial twist, pinch-drag on the map.
- Comfort: lens size, ripple, shimmer, fade timings, push-through speed.
- Text legibility of the year label, credit line and map labels at headset resolution.
- Sharpness of the chosen texture caps.
- Cold-start load time over a real Wi-Fi connection (a 7680 px panorama is about 3.3 MB).
- Archive photo frames (Track F): text legibility (credit line is about 0.5 degrees tall at
  2 m, may be too small), arc width and overlap on Quest field of view, memory and frame rate
  with six ~800x1000 canvas textures. Hide path and fade timing were not exercised in a
  running session.
- Time lens and dial (Track C): whether 25° per dial stop feels right; whether real pinch
  noise skips steps or drops the hold; whether the twist axis (about the pointing direction at
  pinch start) suits real tracked hands; whether the real grip pose puts the lens on the hand;
  comfort of lens size, rim brightness, shimmer and ripple; comfort of the 1.6 s push-through
  growing over the whole view; dial face size and legibility; frame rate and memory with real
  4096 and 5760 px panoramas; left-handed use (lens right hand, dial left hand is fixed).
