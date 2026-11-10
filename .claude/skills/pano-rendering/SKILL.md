---
name: pano-rendering
description: Rules and techniques for showing 360° street panoramas in this project - the pano sphere, texture memory budget, load and dispose order, lining up panoramas from different years, fade-to-black hops, the time lens and push-through effect, and the passthrough portal. Use this whenever you touch anything that displays, swaps, blends, masks or frees a panorama texture, write a shader that samples one, or see blur, seams, misalignment between years, rising memory, or dropped frames in the street view.
---

# Pano rendering (v1 - written before the first prototype)

This is the agreed design, not yet proven on a headset. Where it turns out wrong, fix the
code, then fix this file in the same change, so the next agent does not repeat the mistake.

## The one idea that makes everything line up

A street panorama is treated as infinitely far away. So every effect samples the panorama
by **view direction**, never by mesh UVs or by where a lens mesh happens to be:

```
dir   = normalize(worldPosition - cameraPosition)   // per fragment
dir   = rotateY(dir, headingOffset)                 // per panorama, see "Alignment"
uv    = vec2(atan(dir.z, dir.x) / (2π) + 0.5, asin(dir.y) / π + 0.5)
color = texture(pano, uv)
```

Because direction is the only input, the present and the past stay registered with each
other whatever shape they are drawn on, and both eyes agree. This is why the lens, the
push-through and the portal are the same shader with different masks, not three systems.

## One sphere, two textures, one mask

The pano stage is a single inside-out sphere with one material holding `currentTex`,
`pastTex` and a mask:

- **Time lens:** `mask = smoothstep(r + feather, r - feather, angleBetween(dir, lensDir))`,
  where `lensDir` points from the head to the hand and `r` is the lens's angular radius.
  `color = mix(current, past, mask)`. The hand carries only a thin glowing rim ring; the
  "glass" is the sphere itself. That keeps it to one extra draw call.
- **Push-through:** animate `r` up to π. The past now covers everything. Then swap
  `pastTex` into `currentTex`, reset `r`, dispose the old texture.
- **Magic:** the rim shimmer and the opening ripple are a small distortion of `dir` near the
  mask edge plus an additive glow, driven by a time uniform. Keep it under a degree or two
  of distortion; larger warps on a full-view image are uncomfortable.
- **Passthrough portal:** the same sphere drawn only where a stencil written by the window
  frame passes. Entering the street removes the stencil test.

On desktop the lens direction comes from the mouse ray, so the effect works with no headset.

## Conventions fixed in Phase 0

- World space: north is -Z, east +X, up +Y. Headings are degrees clockwise from north.
- A panorama's centre column looks toward its heading, so
  `u = 0.5 + (azimuth - heading) / 2pi` with `azimuth = atan(d.x, -d.z)`. This is what
  `src/mocks/mock-stage.ts` does. **Unproven against the fixtures**; Track B must flip between
  `public/dev/pano-2023.jpg` and `pano-2025.jpg` and confirm a building keeps its direction.
- The stage sphere is centred on the camera each frame (`onBeforeRender`), radius
  `config.sphereRadiusM`, `depthWrite: false`, `renderOrder: -1000`. In an AR session it
  fully replaces the emulated room and the hands still draw over it (seen in the emulator).
- App content is created with `world.createTransformEntity(obj, { persistent: true })`.
  Without it the entity is tagged to the level and parented to it.
- MapLibre canvas size must be pinned (`clientWidth/Height` override); see `docs/spikes.md`.

## Alignment between years

Two captures of the same street were taken facing different ways, a few metres apart.

- Rotate each panorama about the vertical axis by its compass heading so that north always
  lands on the same world direction. Use `computed_compass_angle`, falling back to
  `compass_angle`.
- The sign and zero point of that rotation are easy to get backwards. Prove it with the two
  fixture panoramas in `public/dev/`: a building visible in both must sit in the same
  direction when you flip between them. Do not trust the formula until you have seen that.
- Position differences cannot be corrected (there is no depth). Nearby objects will jump;
  distant ones will hold. The lens hides this far better than a full-view crossfade, which
  is why the lens is the default and push-through is a deliberate act.

## Memory budget

Quest Browser has a low GPU memory ceiling, and exceeding it shows up as silent crashes or
corrupted textures rather than an error. An 8192×4096 RGBA texture is about 128 MB before
mipmaps, so two of them do not fit comfortably.

- At most **two** panorama textures exist at any moment: current and past.
- Caps live in `src/config.ts`, never inline. Starting values: current up to 8192 wide on
  desktop and 5760 on headset; past (lens) 4096 wide. Never exceed
  `renderer.capabilities.maxTextureSize`. These numbers are untested on a device.
- Decode and downscale off the main thread:
  `createImageBitmap(blob, { resizeWidth, resizeHeight, resizeQuality: 'high' })`.
  A full-size decode on the main thread drops frames, which in a headset is felt as a lurch.
- Set `colorSpace = SRGBColorSpace`. Use linear filtering; add mipmaps only if distant
  detail shimmers, and count their extra third of memory against the budget.
- Free in this order when swapping: stop using the texture in the material, call
  `texture.dispose()`, call `bitmap.close()`. Dispose entities with `entity.dispose()`
  (`entity.destroy()` leaks GPU memory in IWSDK).
- Check for leaks with `renderer.info.memory.textures` after twenty hops; it must not grow.

## Loading order for a hop

1. Fade to black (about 200 ms).
2. Show the 2048 px image as soon as it arrives, fade back in.
3. Swap to the full-size image when ready, with no fade (same picture, sharper).
4. Cancel in-flight loads for a panorama the user has already left, or stale images will
   pop in late.

## Comfort rules (these are requirements, not style)

- Never translate or rotate the viewer's camera smoothly. A panorama gives no depth cues,
  so any artificial motion causes nausea quickly. Hops are fade-out, switch, fade-in.
- The horizon must stay level. Apply heading rotation about the vertical axis only.
- Keep the lens feather soft and the rim animation slow. Flicker near the centre of view
  is tiring.

## Performance

Target 72 Hz with under roughly 100 draw calls for the whole app. The stage itself should
cost one draw call for the sphere and one for the rim. Import Three.js from `@iwsdk/core`,
not from `three`, or two copies of Three end up in the page and materials break in odd ways.

## What cannot be judged without a headset

Sharpness at the chosen caps, real frame rate, memory headroom, and whether the lens size
and ripple feel comfortable. List anything you could not judge in `docs/untested-on-device.md`.
