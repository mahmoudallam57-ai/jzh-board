// Student PIN hashing: salted scrypt, stored as scrypt$N$r$p$salt$hash (base64).
import { scrypt, randomBytes, timingSafeEqual } from "node:crypto";
import { normalizePin } from "./normalize.js";

const N = 16384,
  R = 8,
  P = 1,
  KEYLEN = 32;

function derive(pin, salt, n, r, p) {
  return new Promise((resolve, reject) =>
    scrypt(
      normalizePin(pin),
      salt,
      KEYLEN,
      { N: n, r, p, maxmem: 64 * 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key)),
    ),
  );
}

export async function hashPin(pin) {
  const salt = randomBytes(16);
  const key = await derive(pin, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPin(pin, stored) {
  const parts = String(stored ?? "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, "base64");
  if (expected.length !== KEYLEN) return false;
  const key = await derive(pin, Buffer.from(saltB64, "base64"), +n, +r, +p);
  return timingSafeEqual(key, expected);
}
