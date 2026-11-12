import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryStore } from "../helpers/store-memory.js";
import { checkLock, recordFail, recordSuccess } from "../../lib/throttle.js";

const opts = { max: 5, windowSec: 900, lockSec: 900 };
const T0 = 1_700_000_000_000;

test("four failures do not lock, the fifth does", async () => {
  const store = createMemoryStore();
  for (let i = 0; i < 4; i++) await recordFail(store, "k", T0 + i * 1000, opts);
  assert.equal((await checkLock(store, "k", T0 + 5000)).locked, false);
  await recordFail(store, "k", T0 + 5000, opts);
  const c = await checkLock(store, "k", T0 + 6000);
  assert.equal(c.locked, true);
  assert.ok(
    c.retryAfterSec > 0 && c.retryAfterSec <= 900,
    String(c.retryAfterSec),
  );
});

test("the lock expires after 15 minutes and the counter restarts", async () => {
  const store = createMemoryStore();
  for (let i = 0; i < 5; i++) await recordFail(store, "k", T0, opts);
  assert.equal((await checkLock(store, "k", T0 + 901_000)).locked, false);
  await recordFail(store, "k", T0 + 902_000, opts);
  assert.equal((await checkLock(store, "k", T0 + 903_000)).locked, false);
  assert.equal((await store.getAttempt("k")).fails, 1);
});

test("failures older than the window do not accumulate", async () => {
  const store = createMemoryStore();
  for (let i = 0; i < 4; i++) await recordFail(store, "k", T0, opts);
  await recordFail(store, "k", T0 + 901_000, opts);
  assert.equal((await checkLock(store, "k", T0 + 901_500)).locked, false);
});

test("success clears the record", async () => {
  const store = createMemoryStore();
  for (let i = 0; i < 4; i++) await recordFail(store, "k", T0, opts);
  await recordSuccess(store, "k");
  assert.equal(await store.getAttempt("k"), null);
});

test("lock state lives in the store, not in module memory", async () => {
  const store = createMemoryStore();
  for (let i = 0; i < 5; i++) await recordFail(store, "k", T0, opts);
  const fresh = await import("../../lib/throttle.js?again");
  assert.equal((await fresh.checkLock(store, "k", T0 + 1000)).locked, true);
});
