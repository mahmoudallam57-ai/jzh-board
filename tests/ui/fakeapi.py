"""In-memory stand-in for /api/s/* and /api/t/*, attached to a Playwright context.

Mirrors the real handlers' contracts (status codes and JSON shapes) closely
enough for UI tests. One FakeApi can serve several contexts (devices); each
context gets its own student session, like a cookie would.
"""

import json
import re
import uuid
from urllib.parse import unquote

TEACHER_EMAIL = "teacher@school.ae"
TEACHER_PASSWORD = "pw-ok"
TOKEN = "tok-teacher"
DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789")


def norm(name):
    s = re.sub(r"[ً-ٰٟـ]", "", name or "")
    s = re.sub("[أإآٱ]", "ا", s).replace("ة", "ه").replace("ى", "ي")
    return re.sub(r"\s+", " ", s).strip().lower()


class FakeApi:
    def __init__(self):
        self.classes = [
            {"code": "7/3", "label": "السابع ٣"},
            {"code": "8/1", "label": "الثامن ١"},
        ]
        self.config = {"*": {}}
        self.students = {}  # id -> {id,name,cls,pin}
        self.progress = {}  # id -> {state,summary,version,epoch}
        self.certs = set()
        self.calls = []  # (method, path, body)
        self.fail = set()  # e.g. {"PUT sync"} -> 500
        self.offline = False

    # ----- seeding helpers -----
    def add_student(self, name, cls="7/3", pin="1234", state=None, version=0, epoch=0):
        sid = str(uuid.uuid4())
        self.students[sid] = {"id": sid, "name": name, "cls": cls, "pin": pin}
        self.progress[sid] = {
            "state": state or {},
            "summary": {},
            "version": version,
            "epoch": epoch,
        }
        return sid

    def calls_to(self, method, path):
        return [c for c in self.calls if c[0] == method and c[1] == path]

    def install(self, ctx):
        session = {"sid": None}
        ctx.route(
            re.compile(r".*/api/(s|t)/.*"), lambda route: self._handle(route, session)
        )
        return session

    # ----- routing -----
    def _handle(self, route, session):
        req = route.request
        m = re.search(r"/api/(s|t)/([a-z-]+)", req.url)
        side, action = m.group(1), m.group(2)
        body = None
        if req.post_data:
            try:
                body = json.loads(req.post_data)
            except ValueError:
                body = None
        self.calls.append((req.method, f"{side}/{action}", body))
        if self.offline:
            return route.abort("internetdisconnected")
        if f"{req.method} {action}" in self.fail:
            return self._reply(route, 500, {"error": "server"})
        q = {k: unquote(v) for k, v in re.findall(r"[?&]([^=&]+)=([^&]*)", req.url)}
        fn = getattr(self, f"_{side}_{action.replace('-', '_')}", None)
        if not fn:
            return self._reply(route, 404, {"error": "not_found"})
        status, payload = fn(req.method, body or {}, session, q, req.headers)
        return self._reply(route, status, payload)

    @staticmethod
    def _reply(route, status, payload):
        if payload is None:
            return route.fulfill(status=status, body="")
        if isinstance(payload, str):
            return route.fulfill(
                status=status, body=payload, headers={"content-type": "text/csv"}
            )
        return route.fulfill(
            status=status,
            body=json.dumps(payload),
            headers={"content-type": "application/json"},
        )

    # ----- student side -----
    def _payload(self, sid):
        s, p = self.students[sid], self.progress[sid]
        return {
            "state": p["state"],
            "version": p["version"],
            "epoch": p["epoch"],
            "cert": {"approved": sid in self.certs},
            "settings": self._settings(s["cls"]),
        }

    def _settings(self, cls):
        return {**self.config.get("*", {}), **self.config.get(cls, {})}

    def _login_reply(self, sid, session, status):
        session["sid"] = sid
        p = self._payload(sid)
        s = self.students[sid]
        return status, {
            "student": {"id": sid, "name": s["name"], "cls": s["cls"]},
            "progress": {
                "state": p["state"],
                "version": p["version"],
                "epoch": p["epoch"],
            },
            "cert": p["cert"],
            "settings": p["settings"],
        }

    def _creds(self, b):
        name = re.sub(r"\s+", " ", str(b.get("name", ""))).strip()
        cls = b.get("cls")
        pin = str(b.get("pin", "")).translate(DIGITS)
        if (
            not name
            or cls not in [c["code"] for c in self.classes]
            or not re.fullmatch(r"\d{4}", pin)
        ):
            return None
        return name, cls, pin

    def _s_settings(self, method, b, session, q, h):
        return 200, {
            "classes": self.classes,
            "config": self._settings(q.get("cls", "*")),
        }

    def _s_register(self, method, b, session, q, h):
        c = self._creds(b)
        if not c:
            return 400, {"error": "bad_input"}
        name, cls, pin = c
        if any(
            norm(s["name"]) == norm(name) and s["cls"] == cls
            for s in self.students.values()
        ):
            return 409, {"error": "name_taken"}
        return self._login_reply(self.add_student(name, cls, pin), session, 201)

    def _s_login(self, method, b, session, q, h):
        c = self._creds(b)
        if not c:
            return 400, {"error": "bad_input"}
        name, cls, pin = c
        for s in self.students.values():
            if norm(s["name"]) == norm(name) and s["cls"] == cls and s["pin"] == pin:
                return self._login_reply(s["id"], session, 200)
        return 401, {"error": "invalid"}

    def _s_logout(self, method, b, session, q, h):
        session["sid"] = None
        return 204, None

    def _s_sync(self, method, b, session, q, h):
        sid = session["sid"]
        if not sid or sid not in self.students:
            return 401, {"error": "no_session"}
        p = self.progress[sid]
        if method == "GET":
            return 200, self._payload(sid)
        if b.get("epoch") != p["epoch"] or b.get("baseVersion") != p["version"]:
            reason = "epoch" if b.get("epoch") != p["epoch"] else "stale"
            return 409, {
                "error": reason,
                "server": {
                    "state": p["state"],
                    "version": p["version"],
                    "epoch": p["epoch"],
                },
            }
        p.update(state=b["state"], summary=b["summary"], version=p["version"] + 1)
        return 200, {"version": p["version"], "epoch": p["epoch"]}

    def _s_reset(self, method, b, session, q, h):
        sid = session["sid"]
        if not sid:
            return 401, {"error": "no_session"}
        self.reset(sid)
        return 200, {"version": 0, "epoch": self.progress[sid]["epoch"]}

    def reset(self, sid):
        p = self.progress[sid]
        p.update(state={}, summary={}, version=0, epoch=p["epoch"] + 1)

    # ----- teacher side -----
    def _authed(self, h):
        return h.get("authorization") == f"Bearer {TOKEN}"

    def _t_login(self, method, b, session, q, h):
        if (
            b.get("email", "").lower() == TEACHER_EMAIL
            and b.get("password") == TEACHER_PASSWORD
        ):
            return 200, {"token": TOKEN, "expiresIn": 3600}
        return 401, {"error": "invalid"}

    def _guard(fn):
        def wrapped(self, method, b, session, q, h):
            if not self._authed(h):
                return 401, {"error": "no_session"}
            return fn(self, method, b, session, q, h)

        return wrapped

    @_guard
    def _t_students(self, method, b, session, q, h):
        cls = q.get("cls")
        out = []
        for s in self.students.values():
            if cls and s["cls"] != cls:
                continue
            out.append(
                {
                    "id": s["id"],
                    "name": s["name"],
                    "cls": s["cls"],
                    "summary": self.progress[s["id"]]["summary"],
                    "lastSeenAt": 1700000000000,
                    "createdAt": 1700000000000,
                    "isNew": True,
                    "certApproved": s["id"] in self.certs,
                }
            )
        return 200, sorted(out, key=lambda x: x["name"])

    @_guard
    def _t_student(self, method, b, session, q, h):
        sid = q.get("id")
        if sid not in self.students:
            return 404, {"error": "not_found"}
        s, p = self.students[sid], self.progress[sid]
        return 200, {
            "student": {"id": sid, "name": s["name"], "cls": s["cls"]},
            "state": p["state"],
            "summary": p["summary"],
            "version": p["version"],
            "epoch": p["epoch"],
            "certApproved": sid in self.certs,
        }

    @_guard
    def _t_settings(self, method, b, session, q, h):
        keep = {
            k: v
            for k, v in (b.get("config") or {}).items()
            if k in ("vis", "en", "hub", "pres", "ask", "res")
        }
        self.config[b.get("cls")] = keep
        return 200, {"ok": True}

    @_guard
    def _t_classes(self, method, b, session, q, h):
        self.classes = [
            {"code": c["code"], "label": c.get("label") or c["code"]}
            for c in b.get("classes", [])
        ]
        return 200, {"ok": True}

    @_guard
    def _t_act(self, method, b, session, q, h):
        sid = b.get("id")
        if sid not in self.students:
            return 404, {"error": "not_found"}
        a = b.get("action")
        if a == "reset-progress":
            self.reset(sid)
        elif a == "reset-pin":
            self.students[sid]["pin"] = str(b.get("newPin", "")).translate(DIGITS)
        elif a == "rename":
            self.students[sid]["name"] = b.get("newName")
        elif a == "delete":
            self.students.pop(sid)
            self.progress.pop(sid)
        elif a == "merge":
            self.students.pop(b.get("dropId"), None)
        return 200, {"ok": True}

    @_guard
    def _t_certificate(self, method, b, session, q, h):
        sid = b.get("id")
        if b.get("approved"):
            self.certs.add(sid)
        else:
            self.certs.discard(sid)
        return 200, {"ok": True, "approved": bool(b.get("approved"))}

    @_guard
    def _t_export(self, method, b, session, q, h):
        return 200, "﻿الاسم,الشعبة\r\n"
