/** Bounded read concurrency with stable result ordering. */
export async function readConcurrently<T, U>(
  values: readonly T[],
  read: (value: T) => Promise<U>,
): Promise<U[]> {
  const output: U[] = new Array(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, values.length) }, async () => {
      while (next < values.length) {
        const index = next++;
        output[index] = await read(values[index]!);
      }
    }),
  );
  return output;
}
