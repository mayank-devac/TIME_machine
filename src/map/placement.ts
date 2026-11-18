/**
 * Where the map table stands relative to the viewer. Pure maths, unit tested.
 * The table opens straight ahead of the viewer, at a height that suits their eye level, so a
 * seated user gets a lap-height table and a standing one a desk-height table.
 */
import { config } from '../config.js';
import type { Vec3Like } from '../contracts.js';
import { positionAround, yawFromForward } from '../head.js';

/** Horizontal distance from the eyes to the table centre, metres. */
export const TABLE_DISTANCE_M = 1.15;
/** How far below the eyes the table top sits, metres (a standing 1.6 m eye line gives 0.85 m). */
export const TABLE_BELOW_EYES_M = 0.75;
/** Lowest and highest table top, metres above the floor. Seated eyes (~1.2 m) hit the floor. */
export const TABLE_MIN_HEIGHT_M = 0.6;
export const TABLE_MAX_HEIGHT_M = 1.1;

export interface TablePose {
  position: Vec3Like;
  /** Rotation about +Y, radians; the table's far edge (north on the map at 0) faces away. */
  yaw: number;
}

/**
 * Table top height for eyes `eyeY` metres above the floor. A missing or implausible eye height
 * (no pose yet, or a reference space without a floor) keeps the configured standing height.
 */
export function tableHeightFor(eyeY: number): number {
  if (!Number.isFinite(eyeY) || eyeY < 0.5 || eyeY > 2.5) return config.map.tableHeightM;
  return Math.min(TABLE_MAX_HEIGHT_M, Math.max(TABLE_MIN_HEIGHT_M, eyeY - TABLE_BELOW_EYES_M));
}

/** The table straight ahead of a viewer at `head` looking along `forward`. */
export function tablePoseFor(head: Vec3Like, forward: Vec3Like): TablePose {
  const yaw = yawFromForward(forward.x, forward.z);
  const position = positionAround(head, yaw, { leftDeg: 0, distance: TABLE_DISTANCE_M, dy: 0 }, { x: 0, y: 0, z: 0 });
  position.y = tableHeightFor(head.y);
  return { position, yaw };
}

/** The table before any viewer pose is known: ahead of the world origin, facing north. */
export const DEFAULT_TABLE_POSE: Readonly<TablePose> = {
  position: { x: 0, y: config.map.tableHeightM, z: -TABLE_DISTANCE_M },
  yaw: 0,
};
