// Student API: /api/s/register | login | logout | sync | reset | settings
import { getDeps } from "../../lib/deps.js";
import { send, sendError, readJson, sessionCookie, clientIp, requireMethod, HttpError } from "../../lib/http.js";
import { normalizeName, normalizePin, isValidPin } from "../../lib/normalize.js";
import { hashPin, verifyPin } from "../../lib/pin.js";
import { signSession } from "../../lib/session.js";
import { checkLock, hit, recordSuccess } from "../../lib/throttle.js";
import { requireStudent, validSummary, publicStudent, pinVersion, SESSION_TTL } from "../../lib/student-session.js";

// Per student: every login attempt is counted before the PIN is checked (atomic), cleared on success.
const STUDENT_LIMIT = { max: 5, windowSec: 900, lockSec: 900 };
// Per IP (a whole school can share one): only failed logins count, and generously.
const IP_LIMIT = { max: 200, windowSec: 900, lockSec: 900 };
// Per IP: every register attempt counts (caps name probing and table spam).
const REG_LIMIT = { max: 100, windowSec: 900, lockSec: 900 };
const MAX_NAME = 46;
// A real hash of an unused PIN, so a login for an unknown name costs the same time.
const DUMMY_HASH = hashPin("0000");

function cleanName(v) {
  return typeof v === "string" ? v.normalize("NFKC").replace(/\s+/g, " ").trim() : "";
}

async function readCredentials(req, deps) {
  const body = await readJson(req);
  const name = cleanName(body.name);
  const cls = typeof body.cls === "string" ? body.cls.trim() : "";
  const pin = normalizePin(body.pin);
  const classes = await deps.store.listClasses();
  if (!name || name.length > MAX_NAME || !classes.some(c => c.code === cls) || !isValidPin(pin)) {
    throw new HttpError(400, "bad_input");
  }
  return { name, nameNorm: normalizeName(name), cls, pin };
}

async function guardLock(deps, key) {
  const l = await checkLock(deps.store, key, deps.now());
  if (l.locked) throw new HttpError(429, "locked", { retryAfterSec: l.retryAfterSec });
}

async function countAttempt(deps, key, limit) {
  const h = await hit(deps.store, key, deps.now(), limit);
  if (h.locked) throw new HttpError(429, "locked", { retryAfterSec: h.retryAfterSec });
}

async function sessionPayload(deps, student) {
  const [p, cert, settings] = await Promise.all([
    deps.store.getProgress(student.id),
    deps.store.getCertificate(student.id),
    deps.store.getSettings(student.cls),
  ]);
  return { state: p.state, version: p.version, epoch: p.resetEpoch, cert, settings };
}

async function loginReply(res, deps, student, status) {
  await deps.store.updateStudent(student.id, { lastSeenAt: deps.now() });
  const token = signSession({ sid: student.id, pv: pinVersion(student.pinHash) }, deps.secret, SESSION_TTL, deps.now());
  const { state, version, epoch, cert, settings } = await sessionPayload(deps, student);
  send(res, status, { student: publicStudent(student), progress: { state, version, epoch }, cert, settings },
    { "Set-Cookie": sessionCookie(token, SESSION_TTL) });
}

const actions = {
  async register(req, res, deps) {
    requireMethod(req, ["POST"]);
    await countAttempt(deps, `reg:${clientIp(req)}`, REG_LIMIT);
    const c = await readCredentials(req, deps);
    let student;
    try {
      student = await deps.store.createStudent({ name: c.name, nameNorm: c.nameNorm, cls: c.cls, pinHash: await hashPin(c.pin) });
    } catch (e) {
      if (e.message === "name_taken") throw new HttpError(409, "name_taken");
      throw e;
    }
    await loginReply(res, deps, student, 201);
  },

  async login(req, res, deps) {
    requireMethod(req, ["POST"]);
    const ipKey = `ip:${clientIp(req)}`;
    await guardLock(deps, ipKey);
    const c = await readCredentials(req, deps);
    const stuKey = `stu:${c.nameNorm}|${c.cls}`;
    await countAttempt(deps, stuKey, STUDENT_LIMIT);
    const student = await deps.store.findStudent(c.nameNorm, c.cls);
    const ok = await verifyPin(c.pin, student ? student.pinHash : await DUMMY_HASH);
    if (!student || !ok) {
      await hit(deps.store, ipKey, deps.now(), IP_LIMIT);
      throw new HttpError(401, "invalid");
    }
    await recordSuccess(deps.store, stuKey);
    await loginReply(res, deps, student, 200);
  },

  async logout(req, res) {
    requireMethod(req, ["POST"]);
    send(res, 204, undefined, { "Set-Cookie": sessionCookie("", 0) });
  },

  async sync(req, res, deps) {
    requireMethod(req, ["GET", "PUT"]);
    const student = await requireStudent(req, deps);
    if (req.method === "GET") {
      if (!student.lastSeenAt || deps.now() - student.lastSeenAt > 5 * 60_000) {
        await deps.store.updateStudent(student.id, { lastSeenAt: deps.now() });
      }
      return send(res, 200, await sessionPayload(deps, student));
    }
    const { state, summary, baseVersion, epoch } = await readJson(req);
    if (!state || typeof state !== "object" || Array.isArray(state) || !validSummary(summary)
      || !Number.isInteger(baseVersion) || baseVersion < 0 || !Number.isInteger(epoch) || epoch < 0) {
      throw new HttpError(400, "bad_input");
    }
    const r = await deps.store.putProgress(student.id, { state, summary, baseVersion, epoch });
    if (!r.ok) {
      const s = r.server;
      return send(res, 409, { error: r.reason, server: { state: s.state, version: s.version, epoch: s.resetEpoch } });
    }
    await deps.store.updateStudent(student.id, { lastSeenAt: deps.now() });
    send(res, 200, { version: r.version, epoch });
  },

  async reset(req, res, deps) {
    requireMethod(req, ["POST"]);
    const student = await requireStudent(req, deps);
    await deps.store.resetProgress(student.id);
    const p = await deps.store.getProgress(student.id);
    send(res, 200, { version: p.version, epoch: p.resetEpoch });
  },

  async settings(req, res, deps) {
    requireMethod(req, ["GET"]);
    const cls = typeof req.query.cls === "string" ? req.query.cls : "*";
    const [classes, config] = await Promise.all([deps.store.listClasses(), deps.store.getSettings(cls)]);
    send(res, 200, { classes: classes.map(c => ({ code: c.code, label: c.label })), config });
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
