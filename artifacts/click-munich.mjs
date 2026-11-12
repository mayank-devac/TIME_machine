export default async function run(arg) {
  const names = Object.keys(arg ?? {});
  return { keys: names };
}
