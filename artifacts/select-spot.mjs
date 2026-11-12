export default async function run({ page }) {
  const app = page.frames().find((f) => f !== page.mainFrame());
  return await app.evaluate(async () => {
    window.__tm.bus.emit('spot:selected', { lat: 40.758, lng: -73.985 });
    const until = (pred, ms) => new Promise((res, rej) => {
      const t0 = performance.now();
      const tick = () => (pred() ? res(true) : performance.now() - t0 > ms ? rej(new Error('timeout')) : setTimeout(tick, 100));
      tick();
    });
    await until(() => window.__tm.state.get().mode === 'street', 15000);
    return { mode: window.__tm.state.get().mode };
  });
}
