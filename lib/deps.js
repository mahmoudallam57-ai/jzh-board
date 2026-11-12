// Runtime dependencies. Tests inject fakes through globalThis.__JZH_DEPS__.
import { createSupabaseStore } from "./store-supabase.js";
import { createTeacherAuth } from "./teacher-auth.js";

let cached = null;

export function getDeps() {
  if (globalThis.__JZH_DEPS__) return globalThis.__JZH_DEPS__;
  if (cached) return cached;
  const {
    SUPABASE_URL,
    SUPABASE_SERVICE_KEY,
    SUPABASE_ANON_KEY,
    SESSION_SECRET,
    TEACHER_EMAILS,
  } = process.env;
  if (
    !SUPABASE_URL ||
    !SUPABASE_SERVICE_KEY ||
    !SESSION_SECRET ||
    SESSION_SECRET.length < 32
  ) {
    throw new Error("missing server configuration");
  }
  cached = {
    store: createSupabaseStore(SUPABASE_URL, SUPABASE_SERVICE_KEY),
    secret: SESSION_SECRET,
    now: () => Date.now(),
    teacherAuth: createTeacherAuth(SUPABASE_URL, SUPABASE_ANON_KEY),
    teacherEmails: String(TEACHER_EMAILS || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  };
  return cached;
}
