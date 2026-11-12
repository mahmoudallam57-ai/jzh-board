// Failed-attempt limiter. State lives in the Store so it holds across
// serverless instances. Times are epoch milliseconds.

export async function checkLock(store, key, now) {
  const rec = await store.getAttempt(key);
  if (rec?.lockedUntil && rec.lockedUntil > now) {
    return {
      locked: true,
      retryAfterSec: Math.ceil((rec.lockedUntil - now) / 1000),
    };
  }
  return { locked: false, retryAfterSec: 0 };
}

export async function recordFail(store, key, now, { max, windowSec, lockSec }) {
  const rec = await store.getAttempt(key);
  const expired =
    !rec ||
    (rec.lockedUntil && rec.lockedUntil <= now) ||
    rec.firstAt + windowSec * 1000 < now;
  const next = expired
    ? { fails: 1, firstAt: now, lockedUntil: null }
    : { ...rec, fails: rec.fails + 1 };
  if (next.fails >= max) next.lockedUntil = now + lockSec * 1000;
  await store.putAttempt(key, next);
  return next;
}

export async function recordSuccess(store, key) {
  await store.clearAttempt(key);
}
