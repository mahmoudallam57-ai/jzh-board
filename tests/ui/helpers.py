"""Shared helpers for the UI suite: a static server for public/ and page-driving helpers.

The lesson page keeps its state in localStorage["jzh.v1"]; the assessment booklet keeps
its own in localStorage["jzh.quiz.v1"].  The page's variables live inside IIFEs, so the
tests drive it through the UI, the URL hash and those two storage keys only.
"""
import functools
import http.server
import json
import pathlib
import threading

ROOT = pathlib.Path(__file__).resolve().parents[2] / "public"
STORE = "jzh.v1"
QUIZ_STORE = "jzh.quiz.v1"
TEACHER_EMAIL = "teacher@school.ae"
TEACHER_PASSWORD = "pw-ok"
TMO = 4000  # short explicit timeout (ms) for every wait

GATES = ["story", "film", "plates", "web", "place", "time", "eye", "walk",
         "journal", "res", "harvest", "quiz"]


class _QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a, **k):
        pass


def start_server(directory=ROOT):
    """Serve `directory` on a free port in a daemon thread. Returns (server, base_url)."""
    handler = functools.partial(_QuietHandler, directory=str(directory))
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}/"


def enter_gate(page, name="طالب تجريبي", cls="7/3"):
    """Pass the student entry gate (assumes the page is loaded and the gate is showing)."""
    page.wait_for_selector("#gate:not([hidden])", timeout=TMO)
    page.fill("#gName", name)
    page.fill("#gClass", cls)
    page.click("#gGo")
    page.wait_for_selector("#gate", state="hidden", timeout=TMO)
    # the welcome splash fades out by itself; dismiss it so it never covers clicks
    if page.locator("#wel:not([hidden])").count():
        page.click("#wel", timeout=TMO)
        page.wait_for_selector("#wel", state="hidden", timeout=TMO)


def unlock_teacher(page, email=TEACHER_EMAIL, password=TEACHER_PASSWORD):
    """Sign in through the lock overlay (#tlock) that a teacher-only action opened."""
    page.wait_for_selector("#tlock:not([hidden])", timeout=TMO)
    page.fill("#tMail2", email)
    page.fill("#tPin2", password)
    page.click("#tGo2")
    page.wait_for_selector("#tlock", state="hidden", timeout=TMO)


def wrong_login(page, sel="2"):
    """Type a wrong password into the lock ("2") or the gate card (""); wait for the refusal."""
    page.fill(f"#tMail{sel}", TEACHER_EMAIL)
    page.fill(f"#tPin{sel}", "wrong-password")
    page.click(f"#tGo{sel}")
    page.wait_for_function(f"() => document.querySelector('#tErr{sel}').textContent.includes('غير صحيحة')",
                           timeout=TMO)


def get_state(page, key=STORE):
    return page.evaluate("k => JSON.parse(localStorage.getItem(k) || 'null')", key)


def set_state(page, **patch):
    """Merge `patch` into the saved lesson state.  Call it, then page.reload().
    (The lesson state is only written by explicit save() calls, so this cannot race.)"""
    page.evaluate(
        """([k, patch]) => { const s = JSON.parse(localStorage.getItem(k) || '{}');
             Object.assign(s, patch); localStorage.setItem(k, JSON.stringify(s)); }""",
        [STORE, patch],
    )


def quiz_seed(shape, done_track=None, verified=None):
    """Build a jzh.quiz.v1 value.  `shape` = {track: {bank: item_count}} (read from the page
    once).  `done_track` gets every item submitted+verified, or only `verified` of them."""
    S = {}
    for tk, banks in shape.items():
        S[tk] = {}
        for bank, n in banks.items():
            S[tk][bank] = []
            for _ in range(n):
                S[tk][bank].append({"sub": False, "ver": False, "pts": 0, "ms": 0})
    if done_track:
        left = verified if verified is not None else 10 ** 6
        for bank in S[done_track]:
            for item in S[done_track][bank]:
                if left <= 0:
                    break
                item.update(sub=True, ver=True, pts=1)
                left -= 1
    return {"A": done_track or "map", "S": S, "B": {}, "snd": False, "AI": {}}


def seed_script(seeds):
    """Init script that writes localStorage seeds once per tab, before any page script runs.
    (The booklet re-saves its own key on pagehide, so seeding it from a live page would race.)"""
    payload = json.dumps({k: json.dumps(v) for k, v in seeds.items()})
    return f"""(() => {{
      try {{
        if (sessionStorage.getItem('__seeded')) return;
        sessionStorage.setItem('__seeded', '1');
        const seeds = {payload};
        for (const k in seeds) localStorage.setItem(k, seeds[k]);
      }} catch (e) {{}}
    }})();"""


# Visible text-bearing elements that break the page's type contract (>=14px, weight >=600).
TYPE_FLOOR_JS = """
() => {
  const bad = [];
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    if (!n.nodeValue.trim()) continue;
    const el = n.parentElement;
    if (!el || seen.has(el)) continue;
    seen.add(el);
    if (el.closest('script,style,noscript,template,canvas,svg')) continue;
    let shown = true;
    for (let a = el; a; a = a.parentElement) {
      const c = getComputedStyle(a);
      if (c.display === 'none' || c.visibility === 'hidden' || +c.opacity === 0) { shown = false; break; }
    }
    if (!shown) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const cs = getComputedStyle(el);
    const fs = parseFloat(cs.fontSize), fw = parseInt(cs.fontWeight, 10);
    if (fs < 14 || fw < 600) {
      const cls = typeof el.className === 'string' ? el.className.trim().split(/\\s+/).join('.') : '';
      bad.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls ? '.' + cls : '')
               + ' [' + fs + 'px/' + fw + '] "' + n.nodeValue.trim().slice(0, 24) + '"');
    }
  }
  return bad;
}
"""

# Visible interactive controls (used for the print check).
VISIBLE_CONTROLS_JS = """
() => Array.from(document.querySelectorAll(
    'button,input,select,textarea,[role=button],[contenteditable=true]')).filter(e => {
  for (let a = e; a; a = a.parentElement) {
    const c = getComputedStyle(a);
    if (c.display === 'none' || c.visibility === 'hidden') return false;
  }
  const r = e.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}).map(e => {
  const cls = typeof e.className === 'string' ? e.className.trim().split(/\\s+/).join('.') : '';
  return e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (cls ? '.' + cls : '');
})
"""


def login_ui(page, name, cls="7/3", pin="1234", register=False):
    """Sign in (or register) through the server-mode gate; returns after the reload."""
    page.wait_for_selector("#gClassSel", state="visible", timeout=TMO)
    page.fill("#gName", name)
    page.select_option("#gClassSel", cls)
    if register:
        page.click("#gMode")
    page.fill("#gPin", pin)
    with page.expect_event("load", timeout=TMO):
        page.click("#gGo")
    page.wait_for_selector("#progTxt", state="attached", timeout=TMO)
    page.wait_for_function("() => document.querySelector('#gate').hidden", timeout=TMO)
    if page.locator("#wel:not([hidden])").count():
        page.click("#wel", timeout=TMO)


def who(page):
    return page.evaluate("() => JSON.parse(localStorage.getItem('jzh.who') || 'null')")


def keys(page):
    return page.evaluate("() => Object.keys(localStorage).sort()")
