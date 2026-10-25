/**
 * Bounded parallelism for file work (S6: 8–16 creates in flight beat
 * sequential writes by 3x; more only adds contention).
 */

/** Run `fn` over `items` with at most `concurrency` calls in flight. */
export async function runPool<T>(items: readonly T[], concurrency: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      await fn(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, lane));
}
