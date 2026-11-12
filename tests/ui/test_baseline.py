"""Baseline UI invariants for the v27 lesson board (public/index.html), before any migration.

This is a characterization suite: it documents what the untouched page does today and pins the
invariants of docs/2026-11-13-vercel-supabase-design.md section 4.  Where v27 genuinely breaks
an invariant, the assertion is marked strict-xfail with the offenders listed, so the finding
stays visible and the test turns red the moment behaviour changes.
"""
import json

import pytest

from conftest import DESKTOP, MOBILE
from helpers import (GATES, QUIZ_STORE, TEACHER_PIN, TMO, TYPE_FLOOR_JS, VISIBLE_CONTROLS_JS,
                     enter_gate, get_state, quiz_seed, set_state, unlock_teacher)


# ---------------------------------------------------------------- small utilities

def hub_head(page, i):
    """The i-th hub header on the dashboard (0 goals, 1 gates, 2 resources link, 3 final, 4 badges)."""
    return page.locator(".hubhead").nth(i)


def open_hubs(page):
    return page.eval_on_selector_all(".hub.open", "els => els.map(e => e.dataset.hub)")


def go_hash_and_reload(page, route):
    page.evaluate("r => { location.hash = r }", route)
    page.reload()


def strict_xfail(offenders, reason):
    """xfail(strict=True) for one assertion: pass the assertion's offenders in.
    Empty list -> the invariant now holds, which is a strict failure ("XPASS") so the marker
    gets removed deliberately.  Non-empty -> reported as xfailed with the offenders attached."""
    if offenders:
        pytest.xfail(reason + " | offenders: " + "; ".join(offenders))
    pytest.fail("XPASS(strict): the invariant now holds - remove the xfail. " + reason)


# ---------------------------------------------------------------- 1. entry gate

def test_gate_blocks_until_name(app):
    page = app(enter=False)
    gate = page.locator("#gate")
    assert gate.is_visible()
    assert gate.get_attribute("role") == "dialog" and gate.get_attribute("aria-modal") == "true"

    # the gate sits on top of the dashboard: the page's own buttons are not what a tap reaches
    box = page.locator("#btnTeacher").bounding_box()
    hit = page.evaluate(
        "([x, y]) => !!document.elementFromPoint(x, y).closest('#gate')",
        [box["x"] + box["width"] / 2, box["y"] + box["height"] / 2])
    assert hit, "gate must cover the dashboard"

    # empty name and a one-letter name both bounce
    page.click("#gGo")
    assert gate.is_visible() and page.inner_text("#gErr").strip()
    page.fill("#gName", "ا")
    page.click("#gGo")
    assert gate.is_visible() and page.inner_text("#gErr").strip()
    # Escape does not dismiss it
    page.keyboard.press("Escape")
    assert gate.is_visible()
    saved = get_state(page)
    assert not ((saved or {}).get("notes") or {}).get("certName")

    # a real name opens the board and is remembered
    enter_gate(page, "سالم علي", "8/2")
    assert not gate.is_visible()
    notes = get_state(page)["notes"]
    assert notes["certName"] == "سالم علي" and notes["certClass"] == "8/2"
    assert page.inner_text("#hiName") == "سالم علي"
    page.reload()
    assert not page.locator("#gate").is_visible(), "a returning student is not asked again"


# ---------------------------------------------------------------- 2. dashboard hubs

def test_hubs_closed_on_load_one_open_at_a_time(app):
    page = app()
    assert page.locator(".hubhead").count() == 5
    assert open_hubs(page) == []
    bodies = page.eval_on_selector_all(".hubbody", "els => els.map(e => e.hidden)")
    assert bodies and all(bodies), "every hub body starts hidden"
    heads = page.eval_on_selector_all(
        ".hub[data-hub] .hubhead", "els => els.map(e => e.getAttribute('aria-expanded'))")
    assert set(heads) <= {"false", None}

    hub_head(page, 0).click()
    assert open_hubs(page) == ["goals"]
    assert page.locator('.hub[data-hub="goals"] .hubbody').is_visible()
    assert hub_head(page, 0).get_attribute("aria-expanded") == "true"

    hub_head(page, 1).click()
    assert open_hubs(page) == ["gates"], "opening one closes the other"
    assert not page.locator('.hub[data-hub="goals"] .hubbody').is_visible()
    assert page.locator('.hub[data-hub="gates"] .hubbody').is_visible()

    hub_head(page, 4).click()
    assert open_hubs(page) == ["badges"]

    hub_head(page, 4).click()
    assert open_hubs(page) == [], "clicking the open hub closes it"


# ---------------------------------------------------------------- 3. hidden gate vanishes everywhere

def test_hidden_gate_vanishes_from_progress_and_nav(app):
    page = app()
    others = [g for g in GATES if g != "film"]
    # 12 live gates to start with
    assert page.text_content("#progTxt") == "0/12"
    assert page.text_content("#hcBadge") == "0 من 12 بوابة"

    set_state(page, vis={"gate.film": 0}, visited={g: 1 for g in others})
    page.reload()
    # liveSections() is now 11 long: every counter agrees, and "all done" is reached at 11
    assert page.text_content("#progTxt") == "11/11"
    assert page.text_content("#hcBadge") == "11 من 11 بوابة"
    assert page.text_content("#cbGates") == "11 / 11"
    assert page.text_content("#footProg") == "أتممت البوابات كاملة — استلم شهادتك"
    film_card = page.locator('.card[data-go="film"]')
    assert film_card.count() == 1 and not film_card.is_visible()
    assert "vhide" in film_card.get_attribute("class")

    # prev/next skip it: story -> plates, and the position label counts 11 gates
    hub_head(page, 1).click()
    page.click('.card[data-go="story"]')
    assert page.inner_text("#whereIdx") == "البوابة 1 من 11"
    page.click("#btnNext")
    assert page.inner_text("#whereName") == "لوحات التراث"
    assert page.inner_text("#whereIdx") == "البوابة 2 من 11"
    page.click("#btnPrev")
    assert page.inner_text("#whereName") == "حكاية المكان"


# ---------------------------------------------------------------- 4. teacher panel passcode

def test_teacher_panel_needs_passcode_1971(app):
    # (a) through the teacher card on the entry gate
    page = app(enter=False)
    assert page.locator("#tPin").is_visible()
    page.click("#tGo")
    assert "اكتب الرمز" in page.inner_text("#tErr")
    page.fill("#tPin", "0000")
    page.click("#tGo")
    assert "رمز غير صحيح" in page.inner_text("#tErr")
    assert not page.locator("#v-teacher").is_visible() and page.locator("#gate").is_visible()
    page.fill("#tPin", TEACHER_PIN)
    page.click("#tGo")
    page.wait_for_selector("#v-teacher", state="visible", timeout=TMO)
    page.wait_for_selector("#gate", state="hidden", timeout=TMO)

    # (b) through the home button -> lock overlay; wrong code never reveals the panel,
    #     and after five misses even the right code is refused
    page = app()
    page.click("#btnTeacher")
    assert page.locator("#tlock").is_visible() and not page.locator("#v-teacher").is_visible()
    for i in range(5):
        page.fill("#tPin2", "9999")
        page.click("#tGo2")
        assert "رمز غير صحيح" in page.inner_text("#tErr2")
    assert not page.locator("#v-teacher").is_visible()
    page.fill("#tPin2", TEACHER_PIN)
    page.click("#tGo2")
    assert "محاولات كثيرة" in page.inner_text("#tErr2")
    assert not page.locator("#v-teacher").is_visible()

    # (c) the right code on a fresh load opens it
    page = app()
    page.click("#btnTeacher")
    unlock_teacher(page)
    page.wait_for_selector("#v-teacher", state="visible", timeout=TMO)
    assert page.locator(".ttab").count() == 3


# ---------------------------------------------------------------- 5. AUTHED is never persisted

def test_authed_not_persisted_across_reload(app):
    page = app()
    page.click("#btnTeacher")
    unlock_teacher(page)
    page.wait_for_selector("#v-teacher", state="visible", timeout=TMO)
    # within the page session the teacher stays in: home -> teacher needs no code
    page.click('.ttab[data-t="report"]')
    page.click("#tBack")
    page.wait_for_selector("#home", state="visible", timeout=TMO)
    page.click("#btnTeacher")
    page.wait_for_selector("#v-teacher", state="visible", timeout=TMO)
    assert not page.locator("#tlock").is_visible()

    # nothing about the session reaches storage
    dump = page.evaluate(
        "() => JSON.stringify([localStorage, sessionStorage].map(s => Object.fromEntries(Object.entries(s))))")
    assert "auth" not in dump.lower() and TEACHER_PIN not in dump
    assert "auth" not in json.dumps(get_state(page)).lower()

    # reload (the URL now says #teacher): the code is demanded again, panel stays shut
    page.reload()
    page.wait_for_selector("#tlock", state="visible", timeout=TMO)
    assert not page.locator("#v-teacher").is_visible()
    # and the plain button asks as well
    page.keyboard.press("Escape")
    page.wait_for_selector("#tlock", state="hidden", timeout=TMO)
    page.click("#btnTeacher")
    assert page.locator("#tlock").is_visible() and not page.locator("#v-teacher").is_visible()


# ---------------------------------------------------------------- 6. #teacher with the button hidden

def test_hash_teacher_route_when_button_hidden(app):
    page = app()
    set_state(page, vis={"ui.teacher": 0})
    page.reload()
    btn = page.locator("#btnTeacher")
    assert btn.count() == 1 and not btn.is_visible()
    assert "vhide" in btn.get_attribute("class")
    assert not page.locator("#v-teacher").is_visible()

    go_hash_and_reload(page, "#teacher")
    page.wait_for_selector("#tlock", state="visible", timeout=TMO)
    assert not page.locator("#v-teacher").is_visible()
    page.fill("#tPin2", "0000")
    page.click("#tGo2")
    assert not page.locator("#v-teacher").is_visible()
    unlock_teacher(page)
    page.wait_for_selector("#v-teacher", state="visible", timeout=TMO)
    # the panel itself can show the button again
    page.click('.ttab[data-t="vis"]')
    assert page.locator('#visBox [data-v="ui.teacher"] input').is_visible()
    assert not page.locator('#visBox [data-v="ui.teacher"] input').is_checked()


# ---------------------------------------------------------------- 7. translation

def test_translation_off_by_default(app):
    page = app()
    st = get_state(page)
    assert st["en"] == 0 and st["enset"] == 1
    assert "noen" in page.get_attribute("#app", "class")
    assert page.get_attribute("#langHero", "aria-pressed") == "false"
    assert not page.locator(".h1en .en").is_visible()

    # the switch is teacher-only: the student's tap opens the lock and changes nothing
    page.click("#langHero")
    assert page.locator("#tlock").is_visible()
    assert get_state(page)["en"] == 0 and "noen" in page.get_attribute("#app", "class")
    unlock_teacher(page)
    assert get_state(page)["en"] == 1
    assert "noen" not in page.get_attribute("#app", "class")
    assert page.locator(".h1en .en").is_visible()


# ---------------------------------------------------------------- 8. certificate

def _cert_btn_state(page):
    """(.cbgo disabled?, harvest-view cert button disabled?) read from the DOM."""
    return page.evaluate(
        "() => [document.querySelector('.cbgo').disabled,"
        " document.querySelector(\"#v-harvest [data-go='cert']\").disabled]")


def _cert_page(app, quiz_shape, visited, done_track=None, verified=None, vis=None):
    seeds = {"jzh.v1": {"visited": {g: 1 for g in visited}, "vis": vis or {}}}
    if done_track:
        seeds[QUIZ_STORE] = quiz_seed(quiz_shape, done_track, verified)
    page = app(seeds)
    hub_head(page, 4).click()           # "receive the certificate" hub
    page.wait_for_selector(".cbgo", state="visible", timeout=TMO)
    return page


def test_cert_needs_all_gates_and_quiz_and_passcode(app, quiz_shape):
    n_items = sum(quiz_shape["lap"].values())
    assert n_items == 25

    # nothing done: button disabled, and the #cert route does not open it
    page = _cert_page(app, quiz_shape, [])
    assert _cert_btn_state(page) == [True, True]
    assert "0 / 12" in page.text_content("#cbReq")
    go_hash_and_reload(page, "#cert")
    assert not page.locator("#v-cert").is_visible() and not page.locator("#tlock").is_visible()

    # every gate but no assessment track: still closed
    page = _cert_page(app, quiz_shape, GATES)
    assert _cert_btn_state(page) == [True, True]
    assert page.locator("#cbReq li").nth(0).get_attribute("class") == "done"
    assert page.locator("#cbReq li").nth(1).get_attribute("class") in (None, "")

    # a complete assessment track but one gate missing: closed
    page = _cert_page(app, quiz_shape, [g for g in GATES if g != "walk"], "lap")
    assert _cert_btn_state(page) == [True, True]

    # all gates but the track is one item short of fully verified: closed
    page = _cert_page(app, quiz_shape, GATES, "lap", verified=n_items - 1)
    assert _cert_btn_state(page) == [True, True]
    assert "24 / 25" in page.text_content("#cbReq")

    # all gates + one track fully verified: ready, but the passcode is still required
    page = _cert_page(app, quiz_shape, GATES, "lap")
    assert _cert_btn_state(page) == [False, False]
    assert "25 / 25" in page.text_content("#cbReq")
    page.click(".cbgo")
    page.wait_for_selector("#tlock", state="visible", timeout=TMO)
    assert not page.locator("#v-cert").is_visible()
    page.fill("#tPin2", "0000")
    page.click("#tGo2")
    assert "رمز غير صحيح" in page.inner_text("#tErr2")
    assert not page.locator("#v-cert").is_visible()
    unlock_teacher(page)
    page.wait_for_selector("#v-cert", state="visible", timeout=TMO)

    # the #cert route never opens the certificate by itself, even on a ready board
    # (v27 quirk: at boot the booklet script has not run yet, so the route sees "no quiz")
    page = _cert_page(app, quiz_shape, GATES, "map")
    go_hash_and_reload(page, "#cert")
    page.wait_for_selector("#home", state="visible", timeout=TMO)
    assert not page.locator("#v-cert").is_visible()

    # a hidden gate is not required: 11 live gates visited is enough
    page = _cert_page(app, quiz_shape, [g for g in GATES if g != "film"], "hap", vis={"gate.film": 0})
    assert _cert_btn_state(page) == [False, False]
    assert "11 / 11" in page.text_content("#cbGates")


# ---------------------------------------------------------------- 9. type floor

def _floor_offenders(page):
    return page.evaluate(TYPE_FLOOR_JS)


def _audit_type_floor(page):
    """Walk home (each hub in turn), every question of the booklet plus its results screen,
    and the three teacher-panel tabs.  Returns {screen: [offenders]} for screens with any."""
    found = {}

    def check(label):
        bad = _floor_offenders(page)
        if bad:
            found[label] = bad

    check("home")
    for i in (0, 1, 3, 4):
        hub_head(page, i).click()
        check(f"home/hub{i}")
    hub_head(page, 4).click()           # close again

    # booklet: reach it through the harvest gate's button, then step with "next"
    go_hash_and_reload(page, "#quiz")
    page.wait_for_selector("#v-quiz", state="visible", timeout=TMO)
    check("quiz/q1")
    steps = 0
    while page.locator("#nextB").is_visible() and steps < 40:
        if page.locator("#nextB").is_disabled():
            break
        page.click("#nextB")
        steps += 1
        check(f"quiz/q{steps + 1}")
    assert steps >= 20, "expected to step through the whole booklet"

    # teacher panel tabs
    go_hash_and_reload(page, "#teacher")
    unlock_teacher(page)
    page.wait_for_selector("#v-teacher", state="visible", timeout=TMO)
    for tab in ("report", "vis", "tools"):
        page.click(f'.ttab[data-t="{tab}"]')
        check(f"teacher/{tab}")
    return found


def test_type_floor(app):
    desktop = _audit_type_floor(app(viewport=DESKTOP))
    assert not desktop, f"desktop: text under 14px or weight under 600: {desktop}"
    mobile = _audit_type_floor(app(viewport=MOBILE))
    assert not mobile, f"mobile 390x844: text under 14px or weight under 600: {mobile}"


# ---------------------------------------------------------------- 10. reset

def test_reset_keeps_vis_res_ask(app):
    page = app()
    res = [{"c": "اختبار", "ce": "Test", "col": "var(--brass)", "ic": "book", "s": "قائمة المعلّم",
            "items": [{"id": "x1", "n": "مصدر المعلّم", "ne": "Teacher source", "d": "وصف",
                       "ic": "book", "u": "https://example.org/"}]}]
    set_state(page, vis={"gate.film": 0, "ui.lang": 0}, res=res, ask=0, tpin="abc123",
              visited={"story": 1, "plates": 1}, done={"a": 1}, crit={"c1": 1}, hub="goals",
              notes={"certName": "طالب تجريبي", "h1": "تأمل"})
    page.reload()
    before = get_state(page)
    assert before["visited"] and before["vis"] and before["res"] == res

    page.click("#btnReset")
    page.wait_for_function(
        "() => { const s = JSON.parse(localStorage.getItem('jzh.v1')); return !s || !s.notes || !s.notes.certName }",
        timeout=TMO)
    page.wait_for_load_state("domcontentloaded")
    after = get_state(page)
    # student data is gone ...
    assert after["visited"] == {} and after["done"] == {} and after["crit"] == {}
    assert after["notes"] == {} and after["hub"] == ""
    # ... teacher configuration stays
    assert after["vis"] == {"gate.film": 0, "ui.lang": 0}
    assert after["res"] == res
    assert after["ask"] == 0
    assert after["tpin"] == "abc123"
    assert after["en"] == 0
    # ask=0: nobody is asked for a name after the reset
    assert not page.locator("#gate").is_visible()
    # the hidden gate is still hidden on the reloaded board
    assert page.text_content("#progTxt") == "0/11"


# ---------------------------------------------------------------- 11. print

def test_print_hides_interactive(app):
    """Printing should leave no interactive controls (design section 4).  v27 only hides
    some of the booklet's own chrome; everything else is listed as strict-xfail below.
    Excluded as printed *content* (not chrome): the booklet's answer widgets .qopt/.sit/.qta."""
    page = app()
    page.emulate_media(media="print")

    # what v27 does hold: the booklet's own toolbars/nav are display:none in print
    go_hash_and_reload(page, "#quiz")
    page.wait_for_selector("#v-quiz", state="visible", timeout=TMO)
    page.emulate_media(media="print")
    for sel in ("#v-quiz .topbars", "#v-quiz .botnav", "#v-quiz .acts"):
        displays = page.eval_on_selector_all(sel, "els => els.map(e => getComputedStyle(e).display)")
        assert displays and set(displays) == {"none"}, f"{sel} must be hidden in print: {displays}"
    for sel in ("#gate", "#tlock"):
        assert not page.locator(sel).is_visible()
    assert page.locator("#v-quiz .pagefoot").is_visible()

    # the full invariant: no other visible button/input in print on home or in the booklet
    exempt = (".qopt", ".sit", ".qta")
    offenders = []
    for view, route in (("quiz", None), ("home", "#home")):
        if route:
            page.emulate_media(media="screen")
            go_hash_and_reload(page, route)
            page.wait_for_selector("#home", state="visible", timeout=TMO)
            page.emulate_media(media="print")
        for c in page.evaluate(VISIBLE_CONTROLS_JS):
            if not any(c.endswith(e) or e in c for e in exempt):
                offenders.append(f"{view}:{c}")
    offenders = sorted(set(offenders))
    strict_xfail(offenders, "v27 has no print rule hiding the dashboard hero/hub buttons or the "
                            "global top bar (only #v-quiz chrome is hidden)")


# ---------------------------------------------------------------- 12. footer

def test_footer_text_present(app):
    page = app()
    foot = page.locator(".boardfoot")
    assert foot.is_visible()
    txt = foot.inner_text()
    assert "إعداد معلّم المادة" in txt and "محمود علام محمود" in txt
    # the English line exists in the DOM even while translation is off
    assert "Prepared by MR. Mahmoud Allam Mahmoud" in foot.text_content()
    assert "الجزيرة الحمراء" in txt

    # it is on every gate view, not only home
    hub_head(page, 1).click()
    page.click('.card[data-go="story"]')
    assert page.locator(".boardfoot").is_visible()

    # the booklet carries its own printed footer
    go_hash_and_reload(page, "#quiz")
    page.wait_for_selector("#v-quiz", state="visible", timeout=TMO)
    pf = page.locator("#v-quiz .pagefoot")
    assert "محمود علام محمود" in pf.text_content() and "MR. Mahmoud Allam" in pf.text_content()

    # no teacher toggle can remove the footer: switch every toggle off and it is still there
    go_hash_and_reload(page, "#teacher")
    unlock_teacher(page)
    page.click('.ttab[data-t="vis"]')
    keys = page.eval_on_selector_all("#visBox [data-v]", "els => els.map(e => e.dataset.v)")
    assert len(keys) > 30
    set_state(page, vis={k: 0 for k in keys})
    go_hash_and_reload(page, "#home")
    assert page.locator(".boardfoot").is_visible()
    assert "محمود علام محمود" in page.locator(".boardfoot").inner_text()
