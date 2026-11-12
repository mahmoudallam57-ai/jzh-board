"""Teacher sign-in is checked by the server; the old client passcode is gone for good."""

import base64
import json

from helpers import TMO, get_state, unlock_teacher


def _code(obj):
    return base64.b64encode(json.dumps(obj).encode()).decode()


def test_pasted_old_config_code_never_brings_a_pin_back(app):
    page = app()
    page.click("#btnTeacher")
    unlock_teacher(page)
    page.wait_for_selector("#v-teacher", state="visible", timeout=TMO)
    page.click('.ttab[data-t="tools"]')
    page.fill(
        "#cfgIn", _code({"v": {"gate.film": 0}, "en": 0, "ask": 1, "pin": "1a2b3c"})
    )
    with page.expect_event("load", timeout=TMO):
        page.click("#cfgApply")
    st = get_state(page)
    assert st["vis"] == {"gate.film": 0}
    assert "tpin" not in st


def test_copied_config_code_carries_no_pin(app):
    page = app()
    page.click("#btnTeacher")
    unlock_teacher(page)
    page.wait_for_selector("#v-teacher", state="visible", timeout=TMO)
    page.click('.ttab[data-t="tools"]')
    page.context.grant_permissions(["clipboard-read", "clipboard-write"])
    page.click("#cfgCopy")
    page.wait_for_timeout(200)
    code = page.evaluate("() => navigator.clipboard.readText()")
    data = json.loads(base64.b64decode(code))
    assert "pin" not in data and set(data) <= {"v", "en", "hub", "pres", "ask", "res"}


def test_unreachable_server_says_so(app):
    page = app()
    page.context.route("**/api/t/login", lambda r: r.abort("internetdisconnected"))
    page.click("#btnTeacher")
    page.fill("#tMail2", "teacher@school.ae")
    page.fill("#tPin2", "anything")
    page.click("#tGo2")
    page.wait_for_function(
        "() => document.querySelector('#tErr2').textContent.includes('تعذّر الاتصال')",
        timeout=TMO,
    )
    assert not page.locator("#v-teacher").is_visible()
