import type { Vector3, World } from '@iwsdk/core';

/**
 * Head position (and optionally view direction) in world space. Inside a session this is
 * the XR viewer pose (`player.head`, updated from the XR frame); outside one, the camera.
 * No allocation.
 */
export function readHead(world: World, pos: Vector3, forward?: Vector3): void {
  if (world.session) {
    const head = world.player.head;
    head.getWorldPosition(pos);
    // Object3D.getWorldDirection returns local +Z; a head looks along -Z.
    if (forward) head.getWorldDirection(forward).negate();
  } else {
    world.camera.getWorldPosition(pos);
    if (forward) world.camera.getWorldDirection(forward);
  }
}
