import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryStore } from "../helpers/store-memory.js";
import { checkLock, hit, recordSuccess } from "../../lib/throttle.js";

const opts = { max: 5, windowSec: 900, lockSec: 900 };
const T0 = 1_700_000_000_000;

test("five attempts are allowed, the sixth is blocked", async () => {
  const store = createMemoryStore();
  for (let i = 0; i < 5; i++) assert.equal((await hit(store, "k", T0 + i, opts)).locked, false, `attempt ${i + 1}`);
  const sixth = await hit(store, "k", T0 + 10, opts);
  assert.equal(sixth.locked, true);
  assert.ok(sixth.retryAfterSec > 0 && sixth.retryAfterSec <= 900);
  assert.equal((await checkLock(store, "k", T0 + 20)).locked, true);
});

test("the lock expires after 15 minutes and the count restarts", async () => {
  const store = createMemoryStore();
  for (let i = 0; i < 5; i++) await hit(store, "k", T0, opts);
  const after = await hit(store, "k", T0 + 901_000, opts);
  assert.deepEqual([after.locked, after.fails], [false, 1]);
});

test("attempts older than the window do not accumulate", async () => {
  const store = createMemoryStore();
  for (let i = 0; i < 4; i++) await hit(store, "k", T0, opts);
  assert.equal((await hit(store, "k", T0 + 901_000, opts)).fails, 1);
});

test("success clears the record", async () => {
  const store = createMemoryStore();
  for (let i = 0; i < 4; i++) await hit(store, "k", T0, opts);
  await recordSuccess(store, "k");
  assert.equal(await store.getAttempt("k"), null);
});

test("a parallel burst cannot run past the limit", async () => {
  const store = createMemoryStore();
  const results = await Promise.all(Array.from({ length: 50 }, () => hit(store, "k", T0, opts)));
  assert.equal(results.filter(r => !r.locked).length, 5);
});
