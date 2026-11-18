import type { Vector3, World } from '@iwsdk/core';
import type { Vec3Like } from './contracts.js';

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

// ---------------------------------------------------------------------------------------------
// Placing things around the viewer (pure maths, shared by every track that opens something
// in front of the user: HUD panels, the map table, the portal window, archive frames)
// ---------------------------------------------------------------------------------------------

/**
 * Heading (radians about +Y; 0 = looking down -Z, positive = turned left) of a view
 * direction. Only the horizontal part counts; looking straight up or down reads as north.
 * An object rotated by this yaw has its -Z axis along the heading and its +Z facing back.
 */
export function yawFromForward(fx: number, fz: number): number {
  return Math.hypot(fx, fz) < 1e-4 ? 0 : Math.atan2(-fx, -fz);
}

/** Where something sits relative to a viewer's head and heading. */
export interface ViewerOffset {
  /** Degrees to the left of the heading (negative is right). */
  leftDeg: number;
  /** Horizontal distance from the head, metres. */
  distance: number;
  /** Height relative to the eyes, metres (negative is below the eye line). */
  dy: number;
}

/** World position of `offset` for a head at `head` with heading `yaw`. Writes into `out`. */
export function positionAround(head: Vec3Like, yaw: number, offset: ViewerOffset, out: Vec3Like): Vec3Like {
  const a = yaw + (offset.leftDeg * Math.PI) / 180;
  out.x = head.x - Math.sin(a) * offset.distance;
  out.y = head.y + offset.dy;
  out.z = head.z - Math.cos(a) * offset.distance;
  return out;
}
