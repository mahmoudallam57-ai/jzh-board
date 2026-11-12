// Calls a Vercel-style (req, res) handler in-process with a streamed body.
import { Readable } from "node:stream";
import { createMemoryStore } from "./store-memory.js";

export function makeDeps(over = {}) {
  let t = 1_700_000_000_000;
  const deps = {
    store: createMemoryStore(),
    secret: "test-secret",
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    teacherAuth: null,
    teacherEmails: ["teacher@school.ae"],
    ...over,
  };
  globalThis.__JZH_DEPS__ = deps;
  return deps;
}

export async function call(
  handler,
  {
    method = "GET",
    action,
    query = {},
    body,
    raw,
    cookie,
    headers = {},
    ip = "10.0.0.1",
  } = {},
) {
  const payload =
    raw !== undefined ? raw : body === undefined ? "" : JSON.stringify(body);
  const req = Readable.from(payload ? [Buffer.from(payload)] : []);
  req.method = method;
  req.query = { ...query, ...(action ? { action } : {}) };
  req.headers = { "x-forwarded-for": ip, ...headers };
  if (payload) req.headers["content-type"] = "application/json";
  if (cookie) req.headers.cookie = cookie;
  req.socket = { remoteAddress: ip };

  const res = { statusCode: 200, headers: {}, chunks: [] };
  res.setHeader = (k, v) => {
    res.headers[k.toLowerCase()] = v;
  };
  res.getHeader = (k) => res.headers[k.toLowerCase()];
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  const done = new Promise((resolve) => {
    res.end = (chunk) => {
      if (chunk !== undefined) res.chunks.push(String(chunk));
      resolve();
    };
  });
  await Promise.all([handler(req, res), done]);
  const text = res.chunks.join("");
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  const setCookie = res.headers["set-cookie"];
  const cookieOut = setCookie ? String(setCookie).split(";")[0] : null;
  return {
    status: res.statusCode,
    headers: res.headers,
    text,
    json,
    cookie: cookieOut,
    setCookie,
  };
}
