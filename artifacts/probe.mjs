export default async function run({ page }) {
  const app = page.frames().find((f) => f !== page.mainFrame());
  return await app.evaluate(() => {
    const { world } = window.__tm;
    const root = world.scene.getObjectByName('PortalFrame');
    if (!root) return { error: 'no PortalFrame' };
    root.updateMatrixWorld(true);
    const V = Object.getPrototypeOf(root.position)?.constructor;
    const p = { x: 0, y: 0, z: 0 };
    root.getWorldPosition(p);
    const d = { x: 0, y: 0, z: 0 };
    root.getWorldDirection(d);
    const headObj = world.session ? world.player.head : world.camera;
    const hp = { x: 0, y: 0, z: 0 };
    headObj.getWorldPosition(hp);
    const hx = hp.x - p.x, hz = hp.z - p.z;
    const toLen = Math.hypot(hx, hz) || 1;
    const nLen = Math.hypot(d.x, d.z) || 1;
    const dot = ((d.x * hx) + (d.z * hz)) / (nLen * toLen);
    return {
      ctor: V?.name,
      windowPos: [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)],
      windowNormalYawDeg: +(Math.atan2(d.x, d.z) * 180 / Math.PI).toFixed(1),
      headToWindowYawDeg: +(Math.atan2(-hx, -hz) * 180 / Math.PI).toFixed(1),
      faceDot: +dot.toFixed(3),
      headPos: [+hp.x.toFixed(2), +hp.y.toFixed(2), +hp.z.toFixed(2)],
      visible: root.visible,
      name: root.name,
      parentName: root.parent?.name ?? null,
    };
  });
}
