// Server-side merge of two students' saved progress (teacher "merge duplicate records").
// Uses the exact merge rules the page uses, so no achievement is lost.
import { mergeDoc } from "./merge.js";

const obj = x => (x && typeof x === "object" && !Array.isArray(x) ? x : {});

export function mergeProgress(keep, drop) {
  const a = obj(keep.state), b = obj(drop.state);
  const m = mergeDoc({ main: a.main, quiz: a.quiz, _t: a._t }, { main: b.main, quiz: b.quiz, _t: b._t });
  const sa = obj(keep.summary), sb = obj(drop.summary);
  const dropBetter = (sb.submitted && !sa.submitted)
    || (Boolean(sb.submitted) === Boolean(sa.submitted) && (sb.quizScore ?? -1) > (sa.quizScore ?? -1));
  return {
    state: { main: m.main, quiz: m.quiz, _t: m._t },
    summary: { ...(dropBetter ? sb : sa), visited: Math.max(sa.visited || 0, sb.visited || 0) },
  };
}
