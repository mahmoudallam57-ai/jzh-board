// Attempt limiter. Counting is one atomic store operation (hitAttempt), so a burst of
// parallel requests across serverless instances cannot run past the limit.
// Times are epoch milliseconds.

export async function checkLock(store, key, now) {
  const rec = await store.getAttempt(key);
  if (rec?.lockedUntil && rec.lockedUntil > now) {
    return { locked: true, retryAfterSec: Math.ceil((rec.lockedUntil - now) / 1000) };
  }
  return { locked: false, retryAfterSec: 0 };
}

// Counts this attempt. locked=true means refuse it (429) without doing the work.
export async function hit(store, key, now, { max, windowSec, lockSec }) {
  const r = await store.hitAttempt(key, now, { max, windowSec, lockSec });
  return {
    locked: r.blocked,
    retryAfterSec: r.blocked ? Math.max(1, Math.ceil((r.lockedUntil - now) / 1000)) : 0,
    fails: r.fails,
  };
}

export async function recordSuccess(store, key) {
  await store.clearAttempt(key);
}
