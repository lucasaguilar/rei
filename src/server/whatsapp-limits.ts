/**
 * Bounds for a number open to the public, where nobody chooses how many people write at once.
 *
 *  - A concurrency cap across ALL senders: each turn holds a model call (and, on a local backend,
 *    the GPU); a burst of strangers must queue, not pile up.
 *  - A per-sender rate: one person sending a message a second would otherwise spend a turn — and
 *    provider tokens — on every one of them.
 */

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function maxConcurrentTurns(): number {
  return positiveInt(process.env.REI_WHATSAPP_MAX_CONCURRENT, 4);
}

export function turnsPerMinute(): number {
  return positiveInt(process.env.REI_WHATSAPP_RATE_PER_MIN, 10);
}

/** Runs at most `limit` tasks at once; the rest wait in arrival order. */
export function createSemaphore(limit: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

/**
 * Sliding one-minute window per sender. `check` says whether this message may run a turn, and
 * whether this is the FIRST refusal of the window — the sender is told once, not on every message
 * (a reply per refused message would be the flood answering itself).
 */
export function createRateLimiter(perMinute: number, now: () => number = Date.now) {
  const recent = new Map<string, number[]>();
  const notified = new Map<string, number>();
  return function check(sender: string): { allowed: boolean; notify: boolean } {
    const t = now();
    const windowStart = t - 60_000;
    const stamps = (recent.get(sender) ?? []).filter((s) => s > windowStart);
    if (stamps.length < perMinute) {
      stamps.push(t);
      recent.set(sender, stamps);
      return { allowed: true, notify: false };
    }
    recent.set(sender, stamps);
    const last = notified.get(sender) ?? 0;
    const notify = last <= windowStart;
    if (notify) notified.set(sender, t);
    return { allowed: false, notify };
  };
}
