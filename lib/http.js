// Small HTTP helpers for Vercel Node functions (req: IncomingMessage, res: ServerResponse).

export const MAX_BODY = 512 * 1024;

export class HttpError extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export function send(res, status, obj, headers = {}) {
  res.statusCode = status;
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.setHeader("Cache-Control", "no-store");
  if (obj === undefined) {
    res.end();
    return;
  }
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

export function sendError(res, err) {
  if (err instanceof HttpError)
    return send(res, err.status, { error: err.code, ...err.extra });
  console.error(err);
  return send(res, 500, { error: "server" });
}

// Reads the raw stream (never touches Vercel's lazy req.body) with a hard size cap.
export async function readJson(req) {
  const declared = Number(req.headers["content-length"] || 0);
  if (declared > MAX_BODY) throw new HttpError(413, "too_large");
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, "too_large");
    chunks.push(c);
  }
  if (!size) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw new HttpError(400, "bad_json");
  }
}

export function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0)
      out[part.slice(0, i).trim()] = decodeURIComponent(
        part.slice(i + 1).trim(),
      );
  }
  return out;
}

export function sessionCookie(token, maxAge) {
  return `jzh_s=${token}; HttpOnly; Secure; SameSite=Strict; Path=/api; Max-Age=${maxAge}`;
}

export function clientIp(req) {
  const fwd = String(req.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  return (
    fwd ||
    String(req.headers["x-real-ip"] || "") ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

export function requireMethod(req, allowed) {
  if (!allowed.includes(req.method)) throw new HttpError(405, "method");
}
