export default async function run({ page }) {
  const app = page.frames().find((f) => f !== page.mainFrame());
  return await app.evaluate(() => {
    const { world } = window.__tm;
    const root = world.scene.getObjectByName('PortalFrame');
    if (!root) return { error: 'no PortalFrame' };
    root.updateMatrixWorld(true);
    const get = (obj, fn) => {
      const t = { x: 0, y: 0, z: 0, setFromMatrixPosition(m) { t.x = m.elements[12]; t.y = m.elements[13]; t.z = m.elements[14]; } };
      fn.call(obj, t);
      return t;
    };
    const p = get(root, root.getWorldPosition);
    // +Z of the root in world space (columns of the matrix): readable normal
    const m = root.matrixWorld.elements;
    const nx = m[8], nz = m[10];
    const headObj = world.session ? world.player.head : world.camera;
    headObj.updateMatrixWorld(true);
    const hp = get(headObj, headObj.getWorldPosition);
    const hx = hp.x - p.x, hz = hp.z - p.z;
    const dot = (nx * hx + nz * hz) / (Math.hypot(nx, nz) * Math.hypot(hx, hz) || 1);
    // A HUD panel: its rig root (billboarded every frame by the UI track)
    const rig = world.scene.getObjectByName('DragRig-hud-credits');
    let panel = null;
    if (rig) {
      rig.updateMatrixWorld(true);
      const rp = get(rig, rig.getWorldPosition);
      const rm = rig.matrixWorld.elements;
      const rnx = rm[8], rnz = rm[10];
      const rpx = hp.x - rp.x, rpz = hp.z - rp.z;
      panel = {
        pos: [+rp.x.toFixed(2), +rp.y.toFixed(2), +rp.z.toFixed(2)],
        faceDot: +((rnx * rpx + rnz * rpz) / (Math.hypot(rnx, rnz) * Math.hypot(rpx, rpz) || 1)).toFixed(3),
      };
    }
    return {
      windowPos: [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)],
      windowNormalYawDeg: +(Math.atan2(nx, nz) * 180 / Math.PI).toFixed(1),
      headToWindowYawDeg: +(Math.atan2(-hx, -hz) * 180 / Math.PI).toFixed(1),
      windowFaceDot: +dot.toFixed(3),
      headPos: [+hp.x.toFixed(2), +hp.y.toFixed(2), +hp.z.toFixed(2)],
      panelCredits: panel,
    };
  });
}
