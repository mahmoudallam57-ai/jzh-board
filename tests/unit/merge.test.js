import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync(
  new URL("../../public/index.html", import.meta.url),
  "utf8",
);
const m = /\/\*SYNC:BEGIN\*\/([\s\S]*?)\/\*SYNC:END\*\//.exec(html);
assert.ok(m, "SYNC block present in index.html");
const ctx = vm.createContext({});
vm.runInContext(
  m[1] +
    "\nthis.api={stampChanges,mergeMain,mergeQuiz,mergeDoc,summarize,pickMain,pickQuiz};",
  ctx,
);
const { stampChanges, mergeMain, mergeQuiz, mergeDoc, summarize } = ctx.api;
const plain = (v) => JSON.parse(JSON.stringify(v));

const item = (ver, pts = ver ? 1 : 0) => ({ sub: ver, ver, pts, ms: 0 });
const track = (nVer, total = 4) => ({
  mcq: Array.from({ length: total }, (_, i) => item(i < nVer)),
});
const quiz = (tracks) => ({ S: tracks, B: {}, P: {}, PI: {}, AI: {} });

test("the block has no DOM access", () => {
  assert.doesNotMatch(m[1], /document\.|window\.|localStorage|\$\(/);
});

test("achievements merge by union and never drop a visited gate", () => {
  const out = plain(
    mergeMain(
      { main: { visited: { story: 1 }, badge: { a: 1 } }, _t: {} },
      { main: { visited: { film: 1 }, badge: {} }, _t: {} },
    ),
  );
  assert.deepEqual(out.visited, { story: 1, film: 1 });
  assert.deepEqual(out.badge, { a: 1 });
});

test("text answers: the newer stamp wins per key", () => {
  const l = {
    main: { notes: { j1: "local", j2: "mine" } },
    _t: { "main.notes.j1": 100, "main.notes.j2": 300 },
  };
  const s = {
    main: { notes: { j1: "server", j2: "theirs", j3: "new" } },
    _t: { "main.notes.j1": 200, "main.notes.j2": 250 },
  };
  assert.deepEqual(plain(mergeMain(l, s).notes), {
    j1: "server",
    j2: "mine",
    j3: "new",
  });
});

test("a toggled-off criterion stays off when it is newer", () => {
  const l = { main: { crit: { c1: 0 } }, _t: { "main.crit.c1": 500 } };
  const s = { main: { crit: { c1: 1 } }, _t: { "main.crit.c1": 100 } };
  assert.equal(mergeMain(l, s).crit.c1, 0);
});

test("a submitted quiz track beats a newer unsubmitted one", () => {
  const l = { quiz: quiz({ map: track(4) }), _t: { "quiz.map": 100 } };
  const s = { quiz: quiz({ map: track(1) }), _t: { "quiz.map": 999 } };
  assert.equal(plain(mergeQuiz(l, s)).S.map.mcq.filter((x) => x.ver).length, 4);
  assert.equal(plain(mergeQuiz(s, l)).S.map.mcq.filter((x) => x.ver).length, 4);
});

test("between unsubmitted tracks the newer one wins, track by track", () => {
  const l = {
    quiz: quiz({ lap: track(1), map: track(3) }),
    _t: { "quiz.lap": 500, "quiz.map": 100 },
  };
  const s = {
    quiz: quiz({ lap: track(2), map: track(2) }),
    _t: { "quiz.lap": 100, "quiz.map": 500 },
  };
  const out = plain(mergeQuiz(l, s));
  assert.equal(out.S.lap.mcq.filter((x) => x.ver).length, 1);
  assert.equal(out.S.map.mcq.filter((x) => x.ver).length, 2);
});

test("a missing quiz on one side keeps the other", () => {
  const q = quiz({ map: track(2) });
  assert.deepEqual(
    plain(mergeQuiz({ quiz: null, _t: {} }, { quiz: q, _t: {} })).S,
    q.S,
  );
  assert.equal(mergeQuiz({ quiz: null, _t: {} }, { quiz: null, _t: {} }), null);
});

test("stampChanges stamps only changed keys and keeps old stamps", () => {
  const prev = {
    main: { notes: { a: "1", b: "2" } },
    quiz: quiz({ map: track(1) }),
    _t: { "main.notes.b": 5 },
  };
  const next = {
    main: { notes: { a: "1", b: "3", c: "x" } },
    quiz: quiz({ map: track(2) }),
  };
  const t = plain(stampChanges(prev, next, 42)._t);
  assert.deepEqual(t, {
    "main.notes.b": 42,
    "main.notes.c": 42,
    "quiz.map": 42,
  });
});

test("merging a document with itself changes nothing", () => {
  const d = {
    main: { visited: { story: 1 }, notes: { x: "y" } },
    quiz: quiz({ map: track(2) }),
    _t: { "main.notes.x": 3 },
  };
  const out = plain(mergeDoc(d, d));
  assert.deepEqual(out.main.visited, { story: 1 });
  assert.deepEqual(out.main.notes, { x: "y" });
  assert.deepEqual(out.quiz.S, d.quiz.S);
  assert.deepEqual(out._t, d._t);
});

test("summarize counts only live gates and reports the best track", () => {
  const sum = plain(
    summarize(
      { visited: { story: 1, film: 1, quiz: 1 } },
      quiz({ lap: track(4), map: track(3) }),
      ["story", "quiz", "plates"],
    ),
  );
  assert.deepEqual(sum, {
    visited: 2,
    quizTrack: "lap",
    quizScore: 100,
    submitted: true,
  });
  assert.deepEqual(plain(summarize({}, null, ["story"])), {
    visited: 0,
    quizTrack: null,
    quizScore: null,
    submitted: false,
  });
});

test("lib/merge.js is generated from the page block and has not drifted", () => {
  const lib = readFileSync(new URL("../../lib/merge.js", import.meta.url), "utf8");
  assert.ok(lib.includes(m[0]), "run: python3 scripts/gen-merge.py");
});
