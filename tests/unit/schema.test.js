import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(
  new URL("../../supabase/migrations/0001_init.sql", import.meta.url),
  "utf8",
).toLowerCase();

const tables = [
  ...sql.matchAll(/create table (?:if not exists )?(?:public\.)?([a-z_]+)/g),
].map((m) => m[1]);

test("schema defines the six planned tables", () => {
  assert.deepEqual(tables.sort(), [
    "attempts",
    "certificates",
    "class_settings",
    "classes",
    "progress",
    "students",
  ]);
});

test("every table has row level security enabled", () => {
  for (const t of tables) {
    assert.match(
      sql,
      new RegExp(`alter table (?:public\\.)?${t}\\s+enable row level security`),
      `RLS missing on ${t}`,
    );
  }
});

test("no policies: only the service key may touch the data", () => {
  assert.doesNotMatch(sql, /create policy/);
});

test("students are unique per normalized name and class", () => {
  assert.match(sql, /unique\s*\(\s*name_norm\s*,\s*cls\s*\)/);
});

test("server functions are not callable by anon or authenticated", () => {
  for (const fn of ["put_progress", "hit_attempt"]) {
    assert.match(sql, new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public, anon, authenticated`), fn);
    assert.match(sql, new RegExp(`create or replace function public\\.${fn}[\\s\\S]*?security invoker strict`), fn);
  }
  assert.doesNotMatch(sql, /security definer/);
});
