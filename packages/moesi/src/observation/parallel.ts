/** Bounded read concurrency with stable result ordering. */
export async function readConcurrently<T, U>(
  values: readonly T[],
  read: (value: T) => Promise<U>,
): Promise<U[]> {
  const output: U[] = new Array(values.length);
  let next = 0;
  let failed = false;
  await Promise.all(
    Array.from({ length: Math.min(8, values.length) }, async () => {
      while (!failed && next < values.length) {
        const index = next++;
        try {
          output[index] = await read(values[index]!);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }),
  );
  return output;
}
