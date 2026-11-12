// Student identity helpers shared by the student API.
import { parseCookies, HttpError } from "./http.js";
import { verifySession } from "./session.js";

export const SESSION_TTL = 28800; // 8 hours

export async function requireStudent(req, deps) {
  const tok = parseCookies(req).jzh_s;
  const payload = verifySession(tok, deps.secret, deps.now());
  if (!payload?.sid) throw new HttpError(401, "no_session");
  const student = await deps.store.getStudent(payload.sid);
  // A PIN reset by the teacher ends every session issued under the old PIN.
  if (!student || payload.pv !== pinVersion(student.pinHash)) throw new HttpError(401, "no_session");
  return student;
}

const TRACKS = new Set(["lap", "map", "hap"]);

export function validSummary(s) {
  if (!s || typeof s !== "object") return false;
  const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  return (
    intIn(s.visited, 0, 100) &&
    (s.quizTrack === null || TRACKS.has(s.quizTrack)) &&
    (s.quizScore === null ||
      (typeof s.quizScore === "number" &&
        s.quizScore >= 0 &&
        s.quizScore <= 100)) &&
    typeof s.submitted === "boolean"
  );
}

export function publicStudent(s) {
  return { id: s.id, name: s.name, cls: s.cls };
}

// Short fingerprint of the stored salted PIN hash; changes whenever the PIN is reset.
export function pinVersion(pinHash) {
  return String(pinHash || "").slice(-8);
}
