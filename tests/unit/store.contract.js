// Behaviour every Store must have. Run against the memory fake always and
// against Supabase when SUPABASE_URL/SUPABASE_SERVICE_KEY are set.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

export function runContract(label, makeStore, { skip = false } = {}) {
  const tag = () => "T" + randomBytes(3).toString("hex");

  async function setup() {
    const store = await makeStore();
    const cls = tag();
    await store.putClasses([{ code: cls, label: cls, sort: 0 }], {
      keep: true,
    });
    const made = [];
    const mk = async (name) => {
      const s = await store.createStudent({
        name,
        nameNorm: name,
        cls,
        pinHash: "h",
      });
      made.push(s.id);
      return s;
    };
    const cleanup = async () => {
      for (const id of made) {
        try {
          await store.deleteStudent(id);
        } catch {}
      }
      try {
        await store.removeClass(cls);
      } catch {}
    };
    return { store, cls, mk, cleanup };
  }

  test(
    `${label}: duplicate name in a class is rejected`,
    { skip },
    async () => {
      const { store, cls, mk, cleanup } = await setup();
      try {
        await mk("dup");
        await assert.rejects(
          store.createStudent({
            name: "dup",
            nameNorm: "dup",
            cls,
            pinHash: "h",
          }),
          /name_taken/,
        );
      } finally {
        await cleanup();
      }
    },
  );

  test(
    `${label}: findStudent and getStudent return the stored row`,
    { skip },
    async () => {
      const { store, cls, mk, cleanup } = await setup();
      try {
        const s = await mk("sara");
        assert.equal((await store.findStudent("sara", cls)).id, s.id);
        assert.equal((await store.getStudent(s.id)).pinHash, "h");
        assert.equal(await store.findStudent("nobody", cls), null);
      } finally {
        await cleanup();
      }
    },
  );

  test(
    `${label}: putProgress is compare-and-set on version`,
    { skip },
    async () => {
      const { store, mk, cleanup } = await setup();
      try {
        const s = await mk("p1");
        const p0 = await store.getProgress(s.id);
        assert.deepEqual([p0.version, p0.resetEpoch], [0, 0]);
        const r1 = await store.putProgress(s.id, {
          state: { a: 1 },
          summary: { visited: 1 },
          baseVersion: 0,
          epoch: 0,
        });
        assert.deepEqual(r1, { ok: true, version: 1 });
        const r2 = await store.putProgress(s.id, {
          state: { a: 2 },
          summary: {},
          baseVersion: 0,
          epoch: 0,
        });
        assert.equal(r2.ok, false);
        assert.equal(r2.reason, "stale");
        assert.deepEqual(r2.server, {
          state: { a: 1 },
          version: 1,
          resetEpoch: 0,
        });
        assert.deepEqual((await store.getProgress(s.id)).summary, {
          visited: 1,
        });
      } finally {
        await cleanup();
      }
    },
  );

  test(
    `${label}: resetProgress bumps the epoch and old writers are refused`,
    { skip },
    async () => {
      const { store, mk, cleanup } = await setup();
      try {
        const s = await mk("p2");
        await store.putProgress(s.id, {
          state: { a: 1 },
          summary: {},
          baseVersion: 0,
          epoch: 0,
        });
        await store.resetProgress(s.id);
        const p = await store.getProgress(s.id);
        assert.deepEqual([p.version, p.resetEpoch, p.state], [0, 1, {}]);
        const r = await store.putProgress(s.id, {
          state: { a: 9 },
          summary: {},
          baseVersion: 0,
          epoch: 0,
        });
        assert.equal(r.reason, "epoch");
        const ok = await store.putProgress(s.id, {
          state: { b: 1 },
          summary: {},
          baseVersion: 0,
          epoch: 1,
        });
        assert.equal(ok.ok, true);
      } finally {
        await cleanup();
      }
    },
  );

  test(
    `${label}: getSettings overlays the class row on the default row`,
    { skip },
    async () => {
      const { store, cls, cleanup } = await setup();
      try {
        const base = await store.getSettings("__none__");
        await store.putSettings(cls, { en: 1 });
        const got = await store.getSettings(cls);
        assert.equal(got.en, 1);
        for (const k of Object.keys(base))
          if (k !== "en") assert.deepEqual(got[k], base[k]);
      } finally {
        await store.putSettings(cls, null).catch(() => {});
        await cleanup();
      }
    },
  );

  test(
    `${label}: deleting a student removes progress and certificate`,
    { skip },
    async () => {
      const { store, mk, cleanup } = await setup();
      try {
        const s = await mk("gone");
        await store.putProgress(s.id, {
          state: { a: 1 },
          summary: {},
          baseVersion: 0,
          epoch: 0,
        });
        await store.setCertificate(s.id, "t@x");
        assert.equal((await store.getCertificate(s.id)).approved, true);
        await store.deleteStudent(s.id);
        assert.equal(await store.getStudent(s.id), null);
        assert.equal((await store.getCertificate(s.id)).approved, false);
        assert.deepEqual((await store.getProgress(s.id)).state, {});
      } finally {
        await cleanup();
      }
    },
  );

  test(
    `${label}: certificate can be approved and revoked`,
    { skip },
    async () => {
      const { store, mk, cleanup } = await setup();
      try {
        const s = await mk("cert");
        await store.setCertificate(s.id, "t@x");
        assert.equal((await store.getCertificate(s.id)).approved, true);
        await store.setCertificate(s.id, null);
        assert.equal((await store.getCertificate(s.id)).approved, false);
      } finally {
        await cleanup();
      }
    },
  );

  test(`${label}: mergeStudents keeps one student and both records' achievements`, { skip }, async () => {
    const { store, cls, mk, cleanup } = await setup();
    try {
      const keep = await mk("keep");
      const drop = await mk("drop");
      const sum = (v, sub) => ({ visited: v, quizTrack: sub ? "map" : null, quizScore: sub ? 90 : null, submitted: sub });
      await store.putProgress(keep.id, { state: { main: { visited: { story: 1 } } }, summary: sum(1, false), baseVersion: 0, epoch: 0 });
      const quiz = { S: { map: { mcq: [{ ver: true, pts: 1 }] } }, B: {}, P: {}, PI: {}, AI: {} };
      await store.putProgress(drop.id, { state: { main: { visited: { film: 1 } }, quiz }, summary: sum(1, true), baseVersion: 0, epoch: 0 });
      await store.setCertificate(drop.id, "t@x");
      await store.mergeStudents(keep.id, drop.id);
      const list = await store.listStudents({ cls });
      assert.deepEqual(list.map(s => s.id), [keep.id]);
      const p = await store.getProgress(keep.id);
      assert.deepEqual(p.state.main.visited, { story: 1, film: 1 });
      assert.equal(p.state.quiz.S.map.mcq[0].ver, true);
      assert.equal(p.version, 2);
      assert.equal(list[0].certApproved, true);
      assert.equal(list[0].summary.submitted, true);
      assert.equal("pinHash" in list[0], false);
    } finally { await cleanup(); }
  });

  test(
    `${label}: updateStudent rename collision is name_taken`,
    { skip },
    async () => {
      const { store, mk, cleanup } = await setup();
      try {
        await mk("a1");
        const b = await mk("b1");
        await assert.rejects(
          store.updateStudent(b.id, { name: "a1", nameNorm: "a1" }),
          /name_taken/,
        );
        await store.updateStudent(b.id, { name: "b2", nameNorm: "b2" });
        assert.equal((await store.getStudent(b.id)).name, "b2");
      } finally {
        await cleanup();
      }
    },
  );

  test(`${label}: removing a class in use is refused`, { skip }, async () => {
    const { store, cls, mk, cleanup } = await setup();
    try {
      await mk("x");
      await assert.rejects(store.removeClass(cls), /class_in_use/);
    } finally {
      await cleanup();
    }
  });

  test(
    `${label}: attempts are stored, read and cleared`,
    { skip },
    async () => {
      const store = await makeStore();
      const key = "stu:" + tag();
      assert.equal(await store.getAttempt(key), null);
      await store.putAttempt(key, {
        fails: 2,
        firstAt: 1000_000,
        lockedUntil: null,
      });
      assert.deepEqual(await store.getAttempt(key), {
        fails: 2,
        firstAt: 1000_000,
        lockedUntil: null,
      });
      await store.clearAttempt(key);
      assert.equal(await store.getAttempt(key), null);
    },
  );

  test(`${label}: hitAttempt counts atomically under a parallel burst`, { skip }, async () => {
    const store = await makeStore();
    const key = "stu:" + tag();
    const now = Date.now();
    const rs = await Promise.all(Array.from({ length: 20 }, () =>
      store.hitAttempt(key, now, { max: 5, windowSec: 900, lockSec: 900 })));
    assert.equal(rs.filter(r => !r.blocked).length, 5);
    await store.clearAttempt(key);
  });
}
