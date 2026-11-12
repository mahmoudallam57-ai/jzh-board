import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import handler from "../../api/s/[action].js";
import { call, makeDeps } from "../helpers/harness.js";

let deps;
beforeEach(async () => {
  deps = makeDeps();
  await deps.store.putClasses([
    { code: "7/3", label: "السابع ٣", sort: 1 },
    { code: "8/1", label: "الثامن ١", sort: 2 },
  ]);
});

const reg = (body, extra = {}) =>
  call(handler, { method: "POST", action: "register", body, ...extra });
const login = (body, extra = {}) =>
  call(handler, { method: "POST", action: "login", body, ...extra });

test("register then login round-trip sets the session cookie", async () => {
  const r = await reg({ name: "سارة علي", cls: "7/3", pin: "1234" });
  assert.equal(r.status, 201);
  assert.equal(r.json.student.name, "سارة علي");
  assert.match(
    r.setCookie,
    /^jzh_s=[^;]+; HttpOnly; Secure; SameSite=Strict; Path=\/api; Max-Age=28800$/,
  );
  const l = await login({ name: "ساره  علي", cls: "7/3", pin: "1234" });
  assert.equal(l.status, 200);
  assert.equal(l.json.student.id, r.json.student.id);
  assert.deepEqual(l.json.progress, { state: {}, version: 0, epoch: 0 });
  assert.deepEqual(l.json.cert, { approved: false });
  assert.equal(typeof l.json.settings, "object");
  assert.equal("pinHash" in l.json.student, false);
});

test("unknown name and wrong PIN answer identically", async () => {
  await reg({ name: "سارة", cls: "7/3", pin: "1234" });
  const a = await login(
    { name: "لا أحد", cls: "7/3", pin: "1234" },
    { ip: "10.0.0.2" },
  );
  const b = await login(
    { name: "سارة", cls: "7/3", pin: "9999" },
    { ip: "10.0.0.3" },
  );
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.equal(a.text, b.text);
  assert.deepEqual(a.json, { error: "invalid" });
});

test("five wrong PINs lock the student even with the right PIN", async () => {
  await reg({ name: "سارة", cls: "7/3", pin: "1234" });
  for (let i = 0; i < 5; i++) {
    const r = await login(
      { name: "سارة", cls: "7/3", pin: "0000" },
      { ip: `10.1.0.${i}` },
    );
    assert.equal(r.status, 401);
  }
  const r = await login(
    { name: "سارة", cls: "7/3", pin: "1234" },
    { ip: "10.1.0.9" },
  );
  assert.equal(r.status, 429);
  assert.equal(r.json.error, "locked");
  assert.ok(r.json.retryAfterSec > 0 && r.json.retryAfterSec <= 900);
  deps.advance(901_000);
  assert.equal(
    (await login({ name: "سارة", cls: "7/3", pin: "1234" })).status,
    200,
  );
});

test("a class behind one school IP is not locked out by ordinary mistakes", async () => {
  await reg({ name: "سارة", cls: "7/3", pin: "1234" }, { ip: "9.9.9.9" });
  for (let i = 0; i < 40; i++) await login({ name: `x${i}`, cls: "7/3", pin: "0000" }, { ip: "9.9.9.9" });
  for (let i = 0; i < 30; i++) await reg({ name: "سارة", cls: "7/3", pin: "5555" }, { ip: "9.9.9.9" });
  assert.equal((await login({ name: "سارة", cls: "7/3", pin: "1234" }, { ip: "9.9.9.9" })).status, 200);
});

test("one IP is cut off after 200 failed logins in 15 minutes", async () => {
  await reg({ name: "سارة", cls: "7/3", pin: "1234" }, { ip: "1.1.1.1" });
  for (let i = 0; i < 200; i++) await login({ name: `x${i}`, cls: "7/3", pin: "0000" }, { ip: "9.9.9.9" });
  assert.equal((await login({ name: "سارة", cls: "7/3", pin: "1234" }, { ip: "9.9.9.9" })).status, 429);
});

test("a parallel burst of guesses gets at most five tries at the PIN", async () => {
  await reg({ name: "سارة", cls: "7/3", pin: "1234" });
  const rs = await Promise.all(Array.from({ length: 50 }, (_, i) =>
    login({ name: "سارة", cls: "7/3", pin: String(1000 + i * 7).padStart(4, "0").slice(-4) }, { ip: `10.9.${i}.1` })));
  assert.ok(rs.filter(r => r.status !== 429).length <= 5, rs.map(r => r.status).join(","));
});

test("register attempts from one IP are capped", async () => {
  let last;
  for (let i = 0; i < 101; i++) last = await reg({ name: `ط${i}`, cls: "7/3", pin: "1234" }, { ip: "8.8.8.8" });
  assert.equal(last.status, 429);
});

test("register: duplicate name is 409, bad input is 400", async () => {
  await reg({ name: "سارة", cls: "7/3", pin: "1234" });
  assert.deepEqual(
    (await reg({ name: "ساره", cls: "7/3", pin: "5555" })).json,
    { error: "name_taken" },
  );
  assert.equal(
    (await reg({ name: "سارة", cls: "8/1", pin: "5555" })).status,
    201,
    "same name, other class is fine",
  );
  for (const body of [
    { name: "", cls: "7/3", pin: "1234" },
    { name: "ا".repeat(47), cls: "7/3", pin: "1234" },
    { name: "علي", cls: "9/9", pin: "1234" },
    { name: "علي", cls: "7/3", pin: "12" },
    { name: "علي", cls: "7/3" },
  ]) {
    const r = await reg(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.error, "bad_input");
  }
});

test("names are stored verbatim (escaping is the page's job)", async () => {
  const evil = "<img src=x onerror=alert(1)>";
  const r = await reg({ name: evil, cls: "7/3", pin: "1234" });
  assert.equal(r.status, 201);
  assert.equal(r.json.student.name, evil);
});

test("Arabic-Indic PIN at register matches ASCII at login", async () => {
  await reg({ name: "منى", cls: "7/3", pin: "١٢٣٤" });
  assert.equal(
    (await login({ name: "منى", cls: "7/3", pin: "1234" })).status,
    200,
  );
});

test("sync GET needs a valid cookie", async () => {
  assert.equal((await call(handler, { action: "sync" })).status, 401);
  const forged = "jzh_s=eyJzaWQiOiJ4IiwiZXhwIjo5OTk5OTk5OTk5fQ.AAAA";
  assert.equal(
    (await call(handler, { action: "sync", cookie: forged })).status,
    401,
  );
  const r = await reg({ name: "منى", cls: "7/3", pin: "1234" });
  const other = makeDeps({ store: deps.store, secret: "another-secret" });
  assert.equal(
    (await call(handler, { action: "sync", cookie: r.cookie })).status,
    401,
  );
  globalThis.__JZH_DEPS__ = deps;
  void other;
  assert.equal(
    (await call(handler, { action: "sync", cookie: r.cookie })).status,
    200,
  );
});

test("sync PUT is compare-and-set and reports the server copy on conflict", async () => {
  const { cookie } = await reg({ name: "منى", cls: "7/3", pin: "1234" });
  const summary = {
    visited: 2,
    quizTrack: null,
    quizScore: null,
    submitted: false,
  };
  const put = (body) =>
    call(handler, { method: "PUT", action: "sync", cookie, body });
  const a = await put({
    state: { main: { visited: { story: 1 } } },
    summary,
    baseVersion: 0,
    epoch: 0,
  });
  assert.deepEqual([a.status, a.json], [200, { version: 1, epoch: 0 }]);
  const b = await put({
    state: { main: {} },
    summary,
    baseVersion: 0,
    epoch: 0,
  });
  assert.equal(b.status, 409);
  assert.equal(b.json.error, "stale");
  assert.deepEqual(b.json.server, {
    state: { main: { visited: { story: 1 } } },
    version: 1,
    epoch: 0,
  });
  const g = await call(handler, { action: "sync", cookie });
  assert.deepEqual(
    [g.json.version, g.json.epoch, g.json.state.main.visited.story],
    [1, 0, 1],
  );
});

test("sync PUT after a teacher reset is refused with epoch", async () => {
  const r = await reg({ name: "منى", cls: "7/3", pin: "1234" });
  await deps.store.resetProgress(r.json.student.id);
  const summary = {
    visited: 0,
    quizTrack: null,
    quizScore: null,
    submitted: false,
  };
  const p = await call(handler, {
    method: "PUT",
    action: "sync",
    cookie: r.cookie,
    body: { state: {}, summary, baseVersion: 0, epoch: 0 },
  });
  assert.equal(p.status, 409);
  assert.equal(p.json.error, "epoch");
  assert.equal(p.json.server.epoch, 1);
});

test("sync PUT validates summary and caps the body at 512 KB", async () => {
  const { cookie } = await reg({ name: "منى", cls: "7/3", pin: "1234" });
  const bad = await call(handler, {
    method: "PUT",
    action: "sync",
    cookie,
    body: {
      state: {},
      summary: {
        visited: 500,
        quizTrack: "x",
        quizScore: null,
        submitted: false,
      },
      baseVersion: 0,
      epoch: 0,
    },
  });
  assert.equal(bad.status, 400);
  const big = await call(handler, {
    method: "PUT",
    action: "sync",
    cookie,
    raw: JSON.stringify({ state: { blob: "x".repeat(600 * 1024) } }),
  });
  assert.equal(big.status, 413);
});

test("a deleted student's cookie stops working", async () => {
  const r = await reg({ name: "منى", cls: "7/3", pin: "1234" });
  await deps.store.deleteStudent(r.json.student.id);
  assert.equal(
    (await call(handler, { action: "sync", cookie: r.cookie })).status,
    401,
  );
});

test("logout clears the cookie", async () => {
  const r = await call(handler, { method: "POST", action: "logout" });
  assert.equal(r.status, 204);
  assert.match(r.setCookie, /^jzh_s=; .*Max-Age=0/);
});

test("settings is public and lists classes", async () => {
  await deps.store.putSettings("*", { ask: 1, en: 0 });
  const r = await call(handler, { action: "settings" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.classes, [
    { code: "7/3", label: "السابع ٣" },
    { code: "8/1", label: "الثامن ١" },
  ]);
  assert.deepEqual(r.json.config, { ask: 1, en: 0 });
});

test("wrong method is 405, unknown action is 404", async () => {
  assert.equal(
    (await call(handler, { method: "GET", action: "login" })).status,
    405,
  );
  assert.equal(
    (await call(handler, { method: "GET", action: "nope" })).status,
    404,
  );
});

test("a student can reset their own progress, which bumps the epoch", async () => {
  const r = await reg({ name: "منى", cls: "7/3", pin: "1234" });
  const summary = { visited: 1, quizTrack: null, quizScore: null, submitted: false };
  await call(handler, { method: "PUT", action: "sync", cookie: r.cookie, body: { state: { main: { visited: { story: 1 } } }, summary, baseVersion: 0, epoch: 0 } });
  assert.equal((await call(handler, { method: "POST", action: "reset" })).status, 401);
  const x = await call(handler, { method: "POST", action: "reset", cookie: r.cookie });
  assert.deepEqual([x.status, x.json], [200, { version: 0, epoch: 1 }]);
  const g = await call(handler, { action: "sync", cookie: r.cookie });
  assert.deepEqual([g.json.state, g.json.epoch], [{}, 1]);
});
