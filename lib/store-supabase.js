// Production Store over Supabase (service key; server-side only).
import { createClient } from "@supabase/supabase-js";

const UNIQUE = "23505",
  FK = "23503";

function fail(error, map = {}) {
  if (!error) return;
  if (map[error.code]) throw new Error(map[error.code]);
  throw new Error(`db: ${error.message}`);
}

const toMs = (t) => (t ? Date.parse(t) : null);
const toTs = (ms) => (ms == null ? null : new Date(ms).toISOString());

const rowToStudent = (r) =>
  r && {
    id: r.id,
    name: r.name,
    nameNorm: r.name_norm,
    cls: r.cls,
    pinHash: r.pin_hash,
    createdAt: toMs(r.created_at),
    lastSeenAt: toMs(r.last_seen_at),
  };

const PATCH_COLS = {
  name: "name",
  nameNorm: "name_norm",
  cls: "cls",
  pinHash: "pin_hash",
  lastSeenAt: "last_seen_at",
};

export function createSupabaseStore(url, serviceKey) {
  const db = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const store = {
    async findStudent(nameNorm, cls) {
      const { data, error } = await db
        .from("students")
        .select("*")
        .eq("name_norm", nameNorm)
        .eq("cls", cls)
        .maybeSingle();
      fail(error);
      return rowToStudent(data) ?? null;
    },
    async getStudent(id) {
      const { data, error } = await db
        .from("students")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      fail(error);
      return rowToStudent(data) ?? null;
    },
    async createStudent({ name, nameNorm, cls, pinHash }) {
      const { data, error } = await db
        .from("students")
        .insert({ name, name_norm: nameNorm, cls, pin_hash: pinHash })
        .select()
        .single();
      fail(error, { [UNIQUE]: "name_taken", [FK]: "bad_class" });
      return rowToStudent(data);
    },
    async updateStudent(id, patch) {
      const row = {};
      for (const [k, v] of Object.entries(patch))
        if (PATCH_COLS[k])
          row[PATCH_COLS[k]] = k === "lastSeenAt" ? toTs(v) : v;
      const { data, error } = await db
        .from("students")
        .update(row)
        .eq("id", id)
        .select()
        .maybeSingle();
      fail(error, { [UNIQUE]: "name_taken", [FK]: "bad_class" });
      if (!data) throw new Error("not_found");
      return rowToStudent(data);
    },
    async deleteStudent(id) {
      const { error } = await db.from("students").delete().eq("id", id);
      fail(error);
    },
    async listStudents({ cls } = {}) {
      let q = db
        .from("students")
        .select(
          "id,name,name_norm,cls,created_at,last_seen_at,progress(summary),certificates(student_id)",
        )
        .order("name");
      if (cls) q = q.eq("cls", cls);
      const { data, error } = await q;
      fail(error);
      return data.map((r) => {
        const p = Array.isArray(r.progress) ? r.progress[0] : r.progress;
        const c = Array.isArray(r.certificates)
          ? r.certificates[0]
          : r.certificates;
        return {
          id: r.id,
          name: r.name,
          nameNorm: r.name_norm,
          cls: r.cls,
          createdAt: toMs(r.created_at),
          lastSeenAt: toMs(r.last_seen_at),
          summary: p?.summary ?? {},
          certApproved: Boolean(c),
        };
      });
    },
    async mergeStudents(keepId, dropId) {
      const [k, d] = await Promise.all([
        store.getProgress(keepId),
        store.getProgress(dropId),
      ]);
      if (
        !(await store.getStudent(keepId)) ||
        !(await store.getStudent(dropId))
      )
        throw new Error("not_found");
      if (d.version > k.version) {
        const { error } = await db.from("progress").upsert({
          student_id: keepId,
          state: d.state,
          summary: d.summary,
          version: k.version + 1,
          reset_epoch: k.resetEpoch,
          updated_at: new Date().toISOString(),
        });
        fail(error);
      }
      const [kc, dc] = await Promise.all([
        store.getCertificate(keepId),
        db
          .from("certificates")
          .select("*")
          .eq("student_id", dropId)
          .maybeSingle(),
      ]);
      fail(dc.error);
      if (dc.data && !kc.approved)
        await store.setCertificate(keepId, dc.data.approved_by);
      await store.deleteStudent(dropId);
    },
    async getProgress(sid) {
      const { data, error } = await db
        .from("progress")
        .select("state,summary,version,reset_epoch")
        .eq("student_id", sid)
        .maybeSingle();
      fail(error);
      if (!data) return { state: {}, summary: {}, version: 0, resetEpoch: 0 };
      return {
        state: data.state,
        summary: data.summary,
        version: data.version,
        resetEpoch: data.reset_epoch,
      };
    },
    async putProgress(sid, { state, summary, baseVersion, epoch }) {
      const { data, error } = await db.rpc("put_progress", {
        p_sid: sid,
        p_state: state,
        p_summary: summary,
        p_base: baseVersion,
        p_epoch: epoch,
      });
      fail(error);
      const r = Array.isArray(data) ? data[0] : data;
      if (r.ok) return { ok: true, version: r.version };
      return {
        ok: false,
        reason: r.reason,
        server: {
          state: r.state,
          version: r.version,
          resetEpoch: r.reset_epoch,
        },
      };
    },
    async resetProgress(sid) {
      const cur = await store.getProgress(sid);
      const { error } = await db.from("progress").upsert({
        student_id: sid,
        state: {},
        summary: {},
        version: 0,
        reset_epoch: cur.resetEpoch + 1,
        updated_at: new Date().toISOString(),
      });
      fail(error);
    },
    async listClasses() {
      const { data, error } = await db
        .from("classes")
        .select("code,label,sort")
        .order("sort")
        .order("code");
      fail(error);
      return data;
    },
    async putClasses(list, { keep = false } = {}) {
      if (list.length) {
        const { error } = await db
          .from("classes")
          .upsert(
            list.map((c) => ({
              code: c.code,
              label: c.label,
              sort: c.sort ?? 0,
            })),
          );
        fail(error);
      }
      if (!keep) {
        const wanted = new Set(list.map((c) => c.code));
        for (const c of await store.listClasses())
          if (!wanted.has(c.code)) await store.removeClass(c.code);
      }
    },
    async removeClass(code) {
      const { count, error } = await db
        .from("students")
        .select("id", { count: "exact", head: true })
        .eq("cls", code);
      fail(error);
      if (count > 0) throw new Error("class_in_use");
      const r1 = await db.from("class_settings").delete().eq("cls", code);
      fail(r1.error);
      const r2 = await db.from("classes").delete().eq("code", code);
      fail(r2.error, { [FK]: "class_in_use" });
    },
    async getSettings(cls) {
      const { data, error } = await db
        .from("class_settings")
        .select("cls,config")
        .in("cls", ["*", cls]);
      fail(error);
      const base = data.find((r) => r.cls === "*")?.config ?? {};
      const own =
        cls === "*" ? {} : (data.find((r) => r.cls === cls)?.config ?? {});
      return { ...base, ...own };
    },
    async putSettings(cls, config) {
      if (config === null) {
        const { error } = await db
          .from("class_settings")
          .delete()
          .eq("cls", cls);
        fail(error);
        return;
      }
      const { error } = await db
        .from("class_settings")
        .upsert({ cls, config, updated_at: new Date().toISOString() });
      fail(error);
    },
    async getCertificate(sid) {
      const { data, error } = await db
        .from("certificates")
        .select("student_id")
        .eq("student_id", sid)
        .maybeSingle();
      fail(error);
      return { approved: Boolean(data) };
    },
    async setCertificate(sid, approvedBy) {
      if (approvedBy === null) {
        const { error } = await db
          .from("certificates")
          .delete()
          .eq("student_id", sid);
        fail(error);
        return;
      }
      const { error } = await db
        .from("certificates")
        .upsert({
          student_id: sid,
          approved_by: approvedBy,
          approved_at: new Date().toISOString(),
        });
      fail(error);
    },
    async getAttempt(key) {
      const { data, error } = await db
        .from("attempts")
        .select("*")
        .eq("key", key)
        .maybeSingle();
      fail(error);
      return data
        ? {
            fails: data.fails,
            firstAt: toMs(data.first_at),
            lockedUntil: toMs(data.locked_until),
          }
        : null;
    },
    async putAttempt(key, rec) {
      const { error } = await db.from("attempts").upsert({
        key,
        fails: rec.fails,
        first_at: toTs(rec.firstAt),
        locked_until: toTs(rec.lockedUntil),
      });
      fail(error);
    },
    async clearAttempt(key) {
      const { error } = await db.from("attempts").delete().eq("key", key);
      fail(error);
    },
  };
  return store;
}
