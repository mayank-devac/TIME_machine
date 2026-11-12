export default async function run({ page }) {
  const app = page.frames().find((f) => f !== page.mainFrame());
  const yawDeg = 90;
  return await app.evaluate((deg) => {
    const { world } = window.__tm;
    if (world.session) return { error: 'in session, camera is not the head' };
    const cam = world.camera;
    cam.updateWorldMatrix(true, false);
    const p = { x: 0, y: 0, z: 0 };
    cam.getWorldPosition(p);
    // Yaw `deg` east from north (-Z): forward = (sin, 0, -cos)
    const a = (deg * Math.PI) / 180;
    cam.rotation.set(0, Math.atan2(Math.sin(a), Math.cos(a)) * -1 + 0, 0);
    cam.rotation.y = -a * -1; // yaw = -deg? set below properly
    // forward -Z rotated by yaw y: (−sin y, 0, −cos y) → want (sin a, 0, −cos a) ⇒ y = −a
    cam.rotation.y = -a;
    cam.updateMatrixWorld(true);
    return { yawSet: deg, camPos: [p.x, p.y, p.z] };
  }, yawDeg);
}
