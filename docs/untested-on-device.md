# Untested on a headset

Nobody has run this on a Meta Quest. Everything below is unknown until someone does.
Add to this list; do not remove items without a device test.

## Emulator pass, 2026-11-12 (Meta Quest 3 profile, IWER)

Verified in the emulator only: table mode renders (map, coverage layer, panels);
controller ray hover + click enters street; street bar TIME MACHINE click opens the
lens; push-through fills the view with the past year; held trigger + 25° wrist roll
steps the year (2022 -> 2023, logs confirm) and the "earliest" limit toast fires at
the ladder edge; clicking a hop arrow hops panoramas with the machine still on.
New unknowns found during that pass:

- Settings panel opens 66 degrees to the right of forward — beyond a Quest's
  ~45-49 degree per-side field of view. Places panel sits 52 degrees left in street
  mode (partially out). Both are draggable, but they open out of view. Needs
  placement or an on-device decision.
- A trigger release over a HUD button clicks it: after turning TIME MACHINE off
  with the ray still on its button, the same click hazard exists for any
  hold-then-release over a panel. Check on device whether push-through release
  over a panel button causes stray presses.
- The dial reported "earliest" blocked at 2022 while the places row for that street
  lists 2016 — the row shows archive photo years, the ladder uses panorama
  coverage years. Confirm which is right on a real street before trusting the
  dial's reach.

- Real frame rate (72 Hz target) with the stage sphere, lens shader and map plane.
- Quality governor: whether the session's `frameRate` really reports 72 on Quest (the app never
  asks for more), and whether the "slow" bar (85% of `max(session period, 72 Hz period)`) steps
  down only when it should. Hand-tracking filter numbers (35/110 ms debounce, 60° dial glitch
  limit, 120 ms settle) have never been checked against a real tracked-hand trace.
- Panorama stall timeout (15 s with no bytes): whether Quest Browser streams the Mapillary
  image body in chunks (so slow Wi-Fi never trips it) or delivers it in one piece.
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
- Pano stage (Track B): sharpness at the 5760 and 4096 caps; GPU memory with two textures
  alive; frame rate while decoding; comfort of 200 ms fades; comfort of lens-rim shimmer
  (band is 3x the feather, may need tuning); readability and placement of floor arrows at
  1.6 m; stereo correctness of centring the sphere on each eye; stencil masking with Track E's
  real mask; refit to headset cap when an XR session starts. Not run even in the emulator:
  preview-then-full swap and downscaling (fixtures are only 2048 px), clicking an arrow.
- Map table (Track D): whether Quest Browser keeps calling onBeforeRender during a session
  (redraw is scheduled from it) and whether labels still update; frame cost of re-uploading a
  2048^2 texture up to 30 times a second while panning; legibility of map labels and the
  table-edge credit; real noisy hand pinch against the tap threshold and 48 px snap radius
  (both guesses); two-hand zoom with real hands (only two emulated controllers tested); table
  height and distance comfort; OpenFreeMap tile speed over Wi-Fi on a Quest.
- Room search panel (Track G): whether the Quest Browser offers the Web Speech API (`SpeechRecognition`)
  inside an immersive session and whether it can use the headset microphone; the panel shows
  "NO MIC" and falls back to the keys when it is missing. Speech audio goes to the browser vendor's
  service. Also untested: reach and size of the 5.4 cm keys with a real ray or pinch, panel
  placement (30 degrees right, 1.5 m) and the Photon lookup over Wi-Fi.
- HUD icon buttons and green theme (Track G): the text labels on the street bar, fold, pager and
  search buttons became tinted `<svg>` icons (`public/assets/icons/`), and the palette changed to
  black/white with green accents. Not seen rendered: the managed browser could not create a WebGL
  context when checked, so icon size, tint in both themes, the 8-chip year row width (114 cm) and
  legibility of the new colours at headset distance are unjudged.
