import { getThumbnail } from "@/lib/tauri";

/**
 * Bounded scheduler for `get_thumbnail` requests.
 *
 * A virtualized gallery mounts/unmounts many tiles as the user scrolls or
 * resizes the window, and each tile wants a thumbnail. Firing every request
 * immediately floods the backend: even though decoding now runs on a blocking
 * worker pool (see `src-tauri/src/commands/thumbnail.rs`), an unbounded burst
 * can pin dozens of worker threads — and if a file is an iCloud placeholder the
 * first read blocks for tens of seconds. So we cap the number of in-flight
 * invokes and let the rest wait in a FIFO queue.
 *
 * Requests are abortable: a tile scrolled out of view aborts its request, which
 * both drops the (now stale) result and frees its queue slot for a visible tile.
 * Aborting cannot cancel work already running in Rust — it can't cross the IPC
 * boundary — but it stops the request from ever starting while still queued,
 * which is what matters during fast scrolling.
 */

/** Max concurrent `get_thumbnail` invokes. Small so a scroll burst can't pin the
 * backend worker pool or kick off many iCloud downloads at once. */
const MAX_CONCURRENT = 4;

let active = 0;
const waiters: Array<() => void> = [];

function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waiters.push(() => {
      active += 1;
      resolve();
    });
  });
}

function release(): void {
  active -= 1;
  const next = waiters.shift();
  if (next) next();
}

/** Error thrown when a queued request is aborted before or after it runs. */
export class AbortError extends Error {
  constructor() {
    super("thumbnail request aborted");
    this.name = "AbortError";
  }
}

/**
 * Request a thumbnail through the bounded queue. Rejects with {@link AbortError}
 * if `signal` fires before the result is delivered; otherwise resolves with the
 * on-disk thumbnail path (or rejects with the backend error, e.g. a dataless
 * placeholder — see `useThumbnail`).
 */
export async function requestThumbnail(
  path: string,
  size: number,
  signal: AbortSignal,
): Promise<string> {
  if (signal.aborted) throw new AbortError();
  await acquire();
  try {
    // Re-check after waiting in the queue: the tile may have scrolled away.
    if (signal.aborted) throw new AbortError();
    return await getThumbnail(path, size);
  } finally {
    release();
  }
}
