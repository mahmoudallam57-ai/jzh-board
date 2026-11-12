// Teacher API: /api/t/login | students | student | settings | classes | act | certificate | export
import { getDeps } from "../../lib/deps.js";
import {
  send,
  sendError,
  readJson,
  clientIp,
  requireMethod,
  HttpError,
} from "../../lib/http.js";
import {
  normalizeName,
  normalizePin,
  isValidPin,
} from "../../lib/normalize.js";
import { hashPin } from "../../lib/pin.js";
import { checkLock, recordFail, recordSuccess } from "../../lib/throttle.js";
import { toCsv } from "../../lib/csv.js";

const LIMIT = { max: 5, windowSec: 900, lockSec: 900 };
const IP_LIMIT = { max: 20, windowSec: 900, lockSec: 900 };
const SETTING_KEYS = ["vis", "en", "hub", "pres", "ask", "res"];
const DAY = 24 * 3600_000;

async function requireTeacher(req, deps) {
  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ""));
  const who = m ? await deps.teacherAuth.verify(m[1].trim()) : null;
  if (!who) throw new HttpError(401, "no_session");
  if (!deps.teacherEmails.includes(who.email.toLowerCase()))
    throw new HttpError(403, "forbidden");
  return who;
}

async function mustStudent(deps, id) {
  const s =
    typeof id === "string" && id ? await deps.store.getStudent(id) : null;
  if (!s) throw new HttpError(404, "not_found");
  return s;
}

const cleanName = (v) =>
  typeof v === "string" ? v.normalize("NFKC").replace(/\s+/g, " ").trim() : "";

const actions = {
  async login(req, res, deps) {
    requireMethod(req, ["POST"]);
    const body = await readJson(req);
    const email = String(body.email || "")
      .trim()
      .toLowerCase();
    const password = String(body.password || "");
    if (!email || !password) throw new HttpError(400, "bad_input");
    const keys = [`tch:${email}`, `ip:${clientIp(req)}`];
    for (const k of keys) {
      const l = await checkLock(deps.store, k, deps.now());
      if (l.locked)
        throw new HttpError(429, "locked", { retryAfterSec: l.retryAfterSec });
    }
    const session = await deps.teacherAuth.signIn(email, password);
    if (!session) {
      await recordFail(deps.store, keys[0], deps.now(), LIMIT);
      await recordFail(deps.store, keys[1], deps.now(), IP_LIMIT);
      throw new HttpError(401, "invalid");
    }
    if (!deps.teacherEmails.includes(String(session.email).toLowerCase()))
      throw new HttpError(403, "forbidden");
    await recordSuccess(deps.store, keys[0]);
    send(res, 200, { token: session.token, expiresIn: session.expiresIn });
  },

  async students(req, res, deps) {
    requireMethod(req, ["GET"]);
    await requireTeacher(req, deps);
    const cls =
      typeof req.query.cls === "string" && req.query.cls
        ? req.query.cls
        : undefined;
    const list = await deps.store.listStudents({ cls });
    const now = deps.now();
    send(
      res,
      200,
      list.map((s) => ({
        id: s.id,
        name: s.name,
        cls: s.cls,
        summary: s.summary,
        lastSeenAt: s.lastSeenAt,
        createdAt: s.createdAt,
        isNew: now - s.createdAt < DAY,
        certApproved: s.certApproved,
      })),
    );
  },

  async student(req, res, deps) {
    requireMethod(req, ["GET"]);
    await requireTeacher(req, deps);
    const s = await mustStudent(deps, req.query.id);
    const [p, cert] = await Promise.all([
      deps.store.getProgress(s.id),
      deps.store.getCertificate(s.id),
    ]);
    send(res, 200, {
      student: {
        id: s.id,
        name: s.name,
        cls: s.cls,
        createdAt: s.createdAt,
        lastSeenAt: s.lastSeenAt,
      },
      state: p.state,
      summary: p.summary,
      version: p.version,
      epoch: p.resetEpoch,
      certApproved: cert.approved,
    });
  },

  async settings(req, res, deps) {
    requireMethod(req, ["PUT"]);
    await requireTeacher(req, deps);
    const { cls, config } = await readJson(req);
    const classes = await deps.store.listClasses();
    if (
      typeof cls !== "string" ||
      (cls !== "*" && !classes.some((c) => c.code === cls))
    )
      throw new HttpError(400, "bad_input");
    if (!config || typeof config !== "object" || Array.isArray(config))
      throw new HttpError(400, "bad_input");
    const clean = {};
    for (const k of SETTING_KEYS)
      if (config[k] !== undefined) clean[k] = config[k];
    await deps.store.putSettings(cls, clean);
    send(res, 200, { ok: true });
  },

  async classes(req, res, deps) {
    requireMethod(req, ["PUT"]);
    await requireTeacher(req, deps);
    const { classes } = await readJson(req);
    if (!Array.isArray(classes) || classes.length > 60)
      throw new HttpError(400, "bad_input");
    const seen = new Set();
    const list = classes.map((c, i) => {
      const code = typeof c?.code === "string" ? c.code.trim() : "";
      const label =
        typeof c?.label === "string" && c.label.trim() ? c.label.trim() : code;
      if (
        !code ||
        code.length > 24 ||
        label.length > 40 ||
        seen.has(code) ||
        code === "*"
      )
        throw new HttpError(400, "bad_input");
      seen.add(code);
      return { code, label, sort: Number.isInteger(c.sort) ? c.sort : i };
    });
    try {
      await deps.store.putClasses(list);
    } catch (e) {
      if (e.message === "class_in_use")
        throw new HttpError(409, "class_in_use");
      throw e;
    }
    send(res, 200, { ok: true });
  },

  async act(req, res, deps) {
    requireMethod(req, ["POST"]);
    await requireTeacher(req, deps);
    const { id, action, newPin, newName, dropId } = await readJson(req);
    if (
      !["reset-pin", "reset-progress", "rename", "delete", "merge"].includes(
        action,
      )
    )
      throw new HttpError(400, "bad_input");
    const s = await mustStudent(deps, id);
    if (action === "reset-pin") {
      if (!isValidPin(newPin)) throw new HttpError(400, "bad_input");
      await deps.store.updateStudent(s.id, {
        pinHash: await hashPin(normalizePin(newPin)),
      });
      await deps.store.clearAttempt(`stu:${s.nameNorm}|${s.cls}`);
    } else if (action === "reset-progress") {
      await deps.store.resetProgress(s.id);
    } else if (action === "rename") {
      const name = cleanName(newName);
      if (!name || name.length > 46) throw new HttpError(400, "bad_input");
      try {
        await deps.store.updateStudent(s.id, {
          name,
          nameNorm: normalizeName(name),
        });
      } catch (e) {
        if (e.message === "name_taken") throw new HttpError(409, "name_taken");
        throw e;
      }
    } else if (action === "delete") {
      await deps.store.deleteStudent(s.id);
    } else if (action === "merge") {
      if (dropId === s.id) throw new HttpError(400, "bad_input");
      await mustStudent(deps, dropId);
      await deps.store.mergeStudents(s.id, dropId);
    }
    send(res, 200, { ok: true });
  },

  async certificate(req, res, deps) {
    requireMethod(req, ["POST"]);
    const who = await requireTeacher(req, deps);
    const { id, approved } = await readJson(req);
    if (typeof approved !== "boolean") throw new HttpError(400, "bad_input");
    const s = await mustStudent(deps, id);
    await deps.store.setCertificate(s.id, approved ? who.email : null);
    send(res, 200, { ok: true, approved });
  },

  async export(req, res, deps) {
    requireMethod(req, ["GET"]);
    await requireTeacher(req, deps);
    const cls =
      typeof req.query.cls === "string" && req.query.cls
        ? req.query.cls
        : undefined;
    const list = await deps.store.listStudents({ cls });
    const when = (ms) =>
      ms
        ? new Date(ms).toLocaleString("en-GB", {
            timeZone: "Asia/Dubai",
            hour12: false,
          })
        : "";
    const rows = [
      [
        "الاسم",
        "الشعبة",
        "البوابات المزارة",
        "مسار التقويم",
        "الدرجة",
        "الشهادة",
        "آخر دخول",
      ],
    ];
    for (const s of list) {
      const m = s.summary || {};
      rows.push([
        s.name,
        s.cls,
        m.visited ?? 0,
        (m.quizTrack || "").toUpperCase(),
        m.quizScore ?? "",
        s.certApproved ? "معتمدة" : "",
        when(s.lastSeenAt),
      ]);
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="jzh-students${cls ? "-" + cls.replace(/[^\w-]/g, "_") : ""}.csv"`,
    );
    res.setHeader("Cache-Control", "no-store");
    res.end(toCsv(rows));
  },
};

export default async function handler(req, res) {
  try {
    const fn = actions[req.query?.action];
    if (!fn) throw new HttpError(404, "not_found");
    await fn(req, res, getDeps());
  } catch (err) {
    sendError(res, err);
  }
}
