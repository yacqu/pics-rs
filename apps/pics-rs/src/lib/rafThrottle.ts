/**
 * Coalesce rapid calls into at most one per animation frame, always running with
 * the most recent arguments. Used for scroll and resize handlers, which can fire
 * many times per frame — without this the virtualized gallery re-renders far
 * more often than the screen can paint, which is a big part of the "resizing
 * causes crazy lag" report.
 *
 * The returned function has a `.cancel()` to drop a pending frame on unmount.
 */
export function rafThrottle<A extends unknown[]>(
  fn: (...args: A) => void,
): ((...args: A) => void) & { cancel: () => void } {
  let handle = 0;
  let lastArgs: A | null = null;

  const run = () => {
    handle = 0;
    if (lastArgs) {
      const args = lastArgs;
      lastArgs = null;
      fn(...args);
    }
  };

  const throttled = (...args: A) => {
    lastArgs = args;
    if (handle === 0) handle = requestAnimationFrame(run);
  };

  throttled.cancel = () => {
    if (handle !== 0) cancelAnimationFrame(handle);
    handle = 0;
    lastArgs = null;
  };

  return throttled;
}
