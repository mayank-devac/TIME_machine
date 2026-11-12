export default async function run({ page }) {
  const app = page.frames().find((f) => f !== page.mainFrame());
  return await app.evaluate(async () => {
    const { bus, state } = window.__tm;
    bus.emit('mode:requested', { mode: 'portal' });
    const until = (pred, ms) => new Promise((res, rej) => {
      const t0 = performance.now();
      const tick = () => (pred() ? res(true) : performance.now() - t0 > ms ? rej(new Error('timeout')) : setTimeout(tick, 100));
      tick();
    });
    await until(() => state.get().mode === 'portal', 8000);
    return { mode: state.get().mode };
  });
}
