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
