// In-memory Store used by unit tests. Same contract as lib/store-supabase.js.
import { randomUUID } from "node:crypto";

const clone = (v) => (v === undefined ? v : structuredClone(v));

export function createMemoryStore({ now = () => Date.now() } = {}) {
  const classes = new Map();
  const students = new Map();
  const progress = new Map();
  const settings = new Map([["*", {}]]);
  const certs = new Map();
  const attempts = new Map();

  const taken = (nameNorm, cls, exceptId) =>
    [...students.values()].some(
      (s) => s.nameNorm === nameNorm && s.cls === cls && s.id !== exceptId,
    );
  const prog = (sid) =>
    progress.get(sid) ?? { state: {}, summary: {}, version: 0, resetEpoch: 0 };
  const pub = (s) => {
    const { pinHash, ...rest } = s;
    return rest;
  };

  return {
    async findStudent(nameNorm, cls) {
      const s = [...students.values()].find(
        (x) => x.nameNorm === nameNorm && x.cls === cls,
      );
      return s ? clone(s) : null;
    },
    async getStudent(id) {
      return students.has(id) ? clone(students.get(id)) : null;
    },
    async createStudent({ name, nameNorm, cls, pinHash }) {
      if (taken(nameNorm, cls)) throw new Error("name_taken");
      const s = {
        id: randomUUID(),
        name,
        nameNorm,
        cls,
        pinHash,
        createdAt: now(),
        lastSeenAt: null,
      };
      students.set(s.id, s);
      return clone(s);
    },
    async updateStudent(id, patch) {
      const s = students.get(id);
      if (!s) throw new Error("not_found");
      const next = { ...s, ...patch };
      if (taken(next.nameNorm, next.cls, id)) throw new Error("name_taken");
      students.set(id, next);
      return clone(next);
    },
    async deleteStudent(id) {
      students.delete(id);
      progress.delete(id);
      certs.delete(id);
    },
    async listStudents({ cls } = {}) {
      return [...students.values()]
        .filter((s) => !cls || s.cls === cls)
        .sort((a, b) => a.name.localeCompare(b.name, "ar"))
        .map((s) => ({
          ...pub(clone(s)),
          summary: clone(prog(s.id).summary),
          certApproved: certs.has(s.id),
        }));
    },
    async mergeStudents(keepId, dropId) {
      if (!students.has(keepId) || !students.has(dropId))
        throw new Error("not_found");
      const k = prog(keepId),
        d = prog(dropId);
      if (d.version > k.version) {
        progress.set(keepId, {
          state: clone(d.state),
          summary: clone(d.summary),
          version: k.version + 1,
          resetEpoch: k.resetEpoch,
        });
      }
      if (certs.has(dropId) && !certs.has(keepId))
        certs.set(keepId, certs.get(dropId));
      await this.deleteStudent(dropId);
    },
    async getProgress(sid) {
      return clone(prog(sid));
    },
    async putProgress(sid, { state, summary, baseVersion, epoch }) {
      const cur = prog(sid);
      const server = {
        state: clone(cur.state),
        version: cur.version,
        resetEpoch: cur.resetEpoch,
      };
      if (cur.resetEpoch !== epoch)
        return { ok: false, reason: "epoch", server };
      if (cur.version !== baseVersion)
        return { ok: false, reason: "stale", server };
      progress.set(sid, {
        state: clone(state),
        summary: clone(summary),
        version: cur.version + 1,
        resetEpoch: cur.resetEpoch,
      });
      return { ok: true, version: cur.version + 1 };
    },
    async resetProgress(sid) {
      const cur = prog(sid);
      progress.set(sid, {
        state: {},
        summary: {},
        version: 0,
        resetEpoch: cur.resetEpoch + 1,
      });
    },
    async listClasses() {
      return [...classes.values()]
        .sort((a, b) => a.sort - b.sort || a.code.localeCompare(b.code))
        .map(clone);
    },
    async putClasses(list, { keep = false } = {}) {
      if (!keep) {
        const wanted = new Set(list.map((c) => c.code));
        for (const code of classes.keys())
          if (!wanted.has(code)) await this.removeClass(code);
      }
      for (const c of list)
        classes.set(c.code, {
          code: c.code,
          label: c.label,
          sort: c.sort ?? 0,
        });
    },
    async removeClass(code) {
      if ([...students.values()].some((s) => s.cls === code))
        throw new Error("class_in_use");
      classes.delete(code);
      settings.delete(code);
    },
    async getSettings(cls) {
      return { ...clone(settings.get("*")), ...clone(settings.get(cls) ?? {}) };
    },
    async putSettings(cls, config) {
      if (config === null) settings.delete(cls);
      else settings.set(cls, clone(config));
    },
    async getCertificate(sid) {
      return { approved: certs.has(sid) };
    },
    async setCertificate(sid, approvedBy) {
      if (approvedBy === null) certs.delete(sid);
      else certs.set(sid, { approvedAt: now(), approvedBy });
    },
    async getAttempt(key) {
      return attempts.has(key) ? clone(attempts.get(key)) : null;
    },
    async putAttempt(key, rec) {
      attempts.set(key, clone(rec));
    },
    async clearAttempt(key) {
      attempts.delete(key);
    },
  };
}
