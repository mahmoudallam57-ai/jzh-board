// Stateless student session token: base64url(JSON payload).base64url(HMAC-SHA256).
import { createHmac, timingSafeEqual } from "node:crypto";

const b64u = (buf) => Buffer.from(buf).toString("base64url");

function mac(body, secret) {
  return createHmac("sha256", secret).update(body).digest();
}

export function signSession(payload, secret, ttlSec, now = Date.now()) {
  const body = b64u(
    JSON.stringify({ ...payload, exp: Math.floor(now / 1000) + ttlSec }),
  );
  return `${body}.${b64u(mac(body, secret))}`;
}

export function verifySession(token, secret, now = Date.now()) {
  if (typeof token !== "string" || !secret) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const given = Buffer.from(sig, "base64url");
  const want = mac(body, secret);
  if (given.length !== want.length || !timingSafeEqual(given, want))
    return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (
    !payload ||
    typeof payload.exp !== "number" ||
    Math.floor(now / 1000) > payload.exp
  )
    return null;
  return payload;
}
