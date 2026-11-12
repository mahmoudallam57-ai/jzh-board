import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import teacher from "../../api/t/[action].js";
import student from "../../api/s/[action].js";
import { call, makeDeps } from "../helpers/harness.js";

const GOOD = "good-token",
  OUTSIDER = "outsider-token";
let deps;

beforeEach(async () => {
  deps = makeDeps({
    teacherAuth: {
      async signIn(email, password) {
        if (email === "teacher@school.ae" && password === "pw-ok")
          return { token: GOOD, expiresIn: 3600, email };
        if (email === "other@x.com" && password === "pw-ok")
          return { token: OUTSIDER, expiresIn: 3600, email };
        return null;
      },
      async verify(t) {
        if (t === GOOD) return { email: "teacher@school.ae" };
        if (t === OUTSIDER) return { email: "other@x.com" };
        return null;
      },
    },
  });
  await deps.store.putClasses([
    { code: "7/3", label: "7/3", sort: 1 },
    { code: "8/1", label: "8/1", sort: 2 },
  ]);
});

const auth = (t = GOOD) => ({ authorization: `Bearer ${t}` });
const T = (method, action, opts = {}) =>
  call(teacher, { method, action, headers: auth(), ...opts });
const register = async (name, cls = "7/3", pin = "1234") =>
  await call(student, {
    method: "POST",
    action: "register",
    body: { name, cls, pin },
  });

test("login returns a token for the teacher and refuses wrong passwords", async () => {
  const ok = await call(teacher, {
    method: "POST",
    action: "login",
    body: { email: "Teacher@School.ae", password: "pw-ok" },
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { token: GOOD, expiresIn: 3600 });
  const bad = await call(teacher, {
    method: "POST",
    action: "login",
    body: { email: "teacher@school.ae", password: "nope" },
  });
  assert.deepEqual([bad.status, bad.json], [401, { error: "invalid" }]);
});

test("teacher login is throttled per email", async () => {
  for (let i = 0; i < 5; i++) {
    await call(teacher, {
      method: "POST",
      action: "login",
      body: { email: "teacher@school.ae", password: "x" },
      ip: `10.2.0.${i}`,
    });
  }
  const r = await call(teacher, {
    method: "POST",
    action: "login",
    body: { email: "teacher@school.ae", password: "pw-ok" },
    ip: "10.2.0.9",
  });
  assert.equal(r.status, 429);
});

test("a signed-in user who is not the listed teacher is forbidden", async () => {
  const r = await call(teacher, {
    method: "POST",
    action: "login",
    body: { email: "other@x.com", password: "pw-ok" },
  });
  assert.equal(r.status, 403);
});

test("every protected route is 401 without a token and 403 for an outsider", async () => {
  const routes = [
    ["GET", "students"],
    ["GET", "student"],
    ["PUT", "settings"],
    ["PUT", "classes"],
    ["POST", "act"],
    ["POST", "certificate"],
    ["GET", "export"],
  ];
  for (const [method, action] of routes) {
    assert.equal(
      (await call(teacher, { method, action })).status,
      401,
      `${action} anon`,
    );
    assert.equal(
      (
        await call(teacher, {
          method,
          action,
          headers: { authorization: "Bearer junk" },
        })
      ).status,
      401,
      `${action} junk`,
    );
    assert.equal(
      (await call(teacher, { method, action, headers: auth(OUTSIDER) })).status,
      403,
      `${action} outsider`,
    );
  }
});

test("students list carries summary, isNew and certificate state but no PIN hash", async () => {
  const a = await register("سارة");
  await register("علي", "8/1");
  await deps.store.putProgress(a.json.student.id, {
    state: {},
    summary: { visited: 5, quizTrack: "map", quizScore: 80, submitted: true },
    baseVersion: 0,
    epoch: 0,
  });
  const all = await T("GET", "students");
  assert.equal(all.json.length, 2);
  const only = await T("GET", "students", { query: { cls: "7/3" } });
  assert.equal(only.json.length, 1);
  const s = only.json[0];
  assert.deepEqual(
    [s.name, s.cls, s.summary.visited, s.isNew, s.certApproved],
    ["سارة", "7/3", 5, true, false],
  );
  assert.equal("pinHash" in s, false);
  deps.advance(25 * 3600_000);
  assert.equal((await T("GET", "students")).json[0].isNew, false);
});

test("student detail returns the stored state", async () => {
  const a = await register("سارة");
  await deps.store.putProgress(a.json.student.id, {
    state: { main: { notes: { x: "y" } } },
    summary: { visited: 1, quizTrack: null, quizScore: null, submitted: false },
    baseVersion: 0,
    epoch: 0,
  });
  const d = await T("GET", "student", { query: { id: a.json.student.id } });
  assert.equal(d.status, 200);
  assert.equal(d.json.state.main.notes.x, "y");
  assert.equal(
    (await T("GET", "student", { query: { id: "missing" } })).status,
    404,
  );
});

test("reset-progress bumps the epoch so the student's old copy is refused", async () => {
  const a = await register("سارة");
  const r = await T("POST", "act", {
    body: { id: a.json.student.id, action: "reset-progress" },
  });
  assert.equal(r.status, 200);
  const summary = {
    visited: 0,
    quizTrack: null,
    quizScore: null,
    submitted: false,
  };
  const p = await call(student, {
    method: "PUT",
    action: "sync",
    cookie: a.cookie,
    body: { state: {}, summary, baseVersion: 0, epoch: 0 },
  });
  assert.deepEqual([p.status, p.json.error], [409, "epoch"]);
});

test("reset-pin sets a new PIN and lifts the lock", async () => {
  const a = await register("سارة");
  for (let i = 0; i < 5; i++)
    await call(student, {
      method: "POST",
      action: "login",
      body: { name: "سارة", cls: "7/3", pin: "0000" },
      ip: `10.3.0.${i}`,
    });
  assert.equal(
    (
      await T("POST", "act", {
        body: { id: a.json.student.id, action: "reset-pin", newPin: "12" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await T("POST", "act", {
        body: { id: a.json.student.id, action: "reset-pin", newPin: "٤٤٤٤" },
      })
    ).status,
    200,
  );
  const l = await call(student, {
    method: "POST",
    action: "login",
    body: { name: "سارة", cls: "7/3", pin: "4444" },
  });
  assert.equal(l.status, 200);
});

test("rename re-normalizes and refuses a collision", async () => {
  await register("سارة");
  const b = await register("علي");
  const clash = await T("POST", "act", {
    body: { id: b.json.student.id, action: "rename", newName: "ساره" },
  });
  assert.deepEqual([clash.status, clash.json.error], [409, "name_taken"]);
  const ok = await T("POST", "act", {
    body: { id: b.json.student.id, action: "rename", newName: "علي حسن" },
  });
  assert.equal(ok.status, 200);
  const l = await call(student, {
    method: "POST",
    action: "login",
    body: { name: "علي  حسن", cls: "7/3", pin: "1234" },
  });
  assert.equal(l.status, 200);
});

test("merge leaves one student and delete removes one", async () => {
  const a = await register("سارة");
  const b = await register("سارة ع");
  const m = await T("POST", "act", {
    body: { id: a.json.student.id, action: "merge", dropId: b.json.student.id },
  });
  assert.equal(m.status, 200);
  assert.equal((await T("GET", "students")).json.length, 1);
  assert.equal(
    (
      await T("POST", "act", {
        body: {
          id: a.json.student.id,
          action: "merge",
          dropId: a.json.student.id,
        },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await T("POST", "act", {
        body: { id: a.json.student.id, action: "delete" },
      })
    ).status,
    200,
  );
  assert.equal((await T("GET", "students")).json.length, 0);
  assert.equal(
    (await T("POST", "act", { body: { id: "nobody", action: "delete" } }))
      .status,
    404,
  );
  assert.equal(
    (await T("POST", "act", { body: { id: "x", action: "explode" } })).status,
    400,
  );
});

test("certificate approve then revoke flips what the student sees", async () => {
  const a = await register("سارة");
  const sync = async () =>
    (await call(student, { action: "sync", cookie: a.cookie })).json.cert
      .approved;
  assert.equal(await sync(), false);
  assert.equal(
    (
      await T("POST", "certificate", {
        body: { id: a.json.student.id, approved: true },
      })
    ).status,
    200,
  );
  assert.equal(await sync(), true);
  await T("POST", "certificate", {
    body: { id: a.json.student.id, approved: false },
  });
  assert.equal(await sync(), false);
});

test("settings publish keeps only board keys and never a pin", async () => {
  const r = await T("PUT", "settings", {
    body: {
      cls: "7/3",
      config: { vis: { "gate.film": 0 }, en: 1, ask: 1, pin: "x", evil: 1 },
    },
  });
  assert.equal(r.status, 200);
  const s = await call(student, { action: "settings", query: { cls: "7/3" } });
  assert.deepEqual(s.json.config, { vis: { "gate.film": 0 }, en: 1, ask: 1 });
  assert.equal(
    (await T("PUT", "settings", { body: { cls: "9/9", config: {} } })).status,
    400,
  );
  assert.equal(
    (await T("PUT", "settings", { body: { cls: "*", config: { ask: 0 } } }))
      .status,
    200,
  );
});

test("classes editor replaces the list and refuses removing a class in use", async () => {
  await register("سارة", "8/1");
  const bad = await T("PUT", "classes", {
    body: { classes: [{ code: "7/3", label: "7/3", sort: 1 }] },
  });
  assert.deepEqual([bad.status, bad.json.error], [409, "class_in_use"]);
  const ok = await T("PUT", "classes", {
    body: {
      classes: [
        { code: "8/1", label: "ثامن ١", sort: 1 },
        { code: "9/2", label: "تاسع ٢", sort: 2 },
      ],
    },
  });
  assert.equal(ok.status, 200);
  const s = await call(student, { action: "settings" });
  assert.deepEqual(
    s.json.classes.map((c) => c.code),
    ["8/1", "9/2"],
  );
  assert.equal(
    (
      await T("PUT", "classes", {
        body: { classes: [{ code: "", label: "x" }] },
      })
    ).status,
    400,
  );
});

test("CSV export: BOM, quoting and formula guard", async () => {
  await register('علي, "الصغير"');
  await register("=HYPERLINK(1)");
  const r = await T("GET", "export");
  assert.equal(r.status, 200);
  assert.match(r.headers["content-type"], /^text\/csv/);
  assert.equal(r.text.charCodeAt(0), 0xfeff);
  assert.ok(r.text.includes('"علي, ""الصغير"""'), r.text);
  assert.ok(r.text.includes("'=HYPERLINK(1)"), r.text);
  assert.equal(r.text.trim().split("\r\n").length, 3);
});
