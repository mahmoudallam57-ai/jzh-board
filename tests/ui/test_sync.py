"""Server sync and the student gate, against the in-memory FakeApi."""

import json

from fakeapi import FakeApi
from helpers import TMO, keys, login_ui, who


def visited_main(api, sid):
    return api.progress[sid]["state"].get("main", {}).get("visited", {})


def test_login_pulls_server_progress(device):
    api = FakeApi()
    sid = api.add_student(
        "سارة علي", state={"main": {"visited": {"story": 1, "film": 1}}}, version=3
    )
    page = device(api)
    login_ui(page, "ساره  علي")
    assert who(page)["sid"] == sid
    assert page.text_content("#progTxt") == "2/12"
    assert f"jzh.v1.{sid}" in keys(page) and f"jzh.sync.{sid}" in keys(page)
    assert page.inner_text("#hiName") == "سارة علي"
    assert (
        page.locator("#btnLogout").is_visible()
        and not page.locator("#hiEdit").is_visible()
    )


def test_register_then_edits_push_once(device):
    api = FakeApi()
    page = device(api)
    login_ui(page, "منى", register=True, pin="٢٤٦٨")
    sid = who(page)["sid"]
    assert api.students[sid]["pin"] == "2468", "Arabic-Indic digits are sent as ASCII"
    before = len(api.calls_to("PUT", "s/sync"))
    page.keyboard.press("ArrowLeft")
    page.keyboard.press("ArrowLeft")
    page.wait_for_timeout(2600)
    puts = api.calls_to("PUT", "s/sync")[before:]
    assert len(puts) == 1, puts
    assert visited_main(api, sid) == {"story": 1, "film": 1}
    assert puts[0][2]["summary"]["visited"] == 2


def test_progress_follows_the_student_to_another_device(device):
    api = FakeApi()
    api.add_student("سارة")
    a = device(api)
    login_ui(a, "سارة")
    a.keyboard.press("ArrowLeft")
    a.keyboard.press("ArrowLeft")
    a.wait_for_timeout(2600)
    b = device(api)
    login_ui(b, "سارة")
    assert b.text_content("#progTxt") == "2/12"


def test_teacher_reset_clears_local_progress(device):
    api = FakeApi()
    sid = api.add_student("سارة")
    page = device(api)
    login_ui(page, "سارة")
    page.keyboard.press("ArrowLeft")
    page.wait_for_timeout(2600)
    assert visited_main(api, sid) == {"story": 1}
    api.reset(sid)
    with page.expect_event("load", timeout=8000):
        page.keyboard.press("ArrowLeft")
    page.wait_for_selector("#progTxt", state="attached")
    page.keyboard.press("Escape")
    assert page.text_content("#progTxt").startswith(
        "1/"
    ), "only the gate visited after the reset survives"
    assert api.progress[sid]["epoch"] == 1


def test_failed_save_shows_banner_and_recovers(device):
    api = FakeApi()
    api.add_student("سارة")
    page = device(api)
    login_ui(page, "سارة")
    api.fail.add("PUT sync")
    page.keyboard.press("ArrowLeft")
    page.wait_for_selector("#syncBar:not([hidden])", timeout=4000)
    assert "لم يُحفظ" in page.inner_text("#syncBar")
    api.fail.clear()
    page.keyboard.press("ArrowLeft")
    page.wait_for_selector("#syncBar", state="hidden", timeout=4000)


def test_offline_student_keeps_working_on_the_same_device(device):
    api = FakeApi()
    sid = api.add_student("سارة")
    page = device(api)
    login_ui(page, "سارة")
    api.offline = True
    page.keyboard.press("ArrowLeft")
    page.wait_for_selector("#syncBar:not([hidden])", timeout=4000)
    page.reload()
    page.keyboard.press("Escape")
    assert not page.locator("#gate").is_visible()
    assert page.text_content("#progTxt") == "1/12"
    api.offline = False
    page.reload()
    page.wait_for_timeout(2600)
    assert visited_main(api, sid) == {"story": 1}


def test_two_students_on_one_device_never_mix(device):
    api = FakeApi()
    api.add_student("سارة")
    api.add_student("علي")
    page = device(api)
    login_ui(page, "سارة")
    sara = who(page)["sid"]
    page.keyboard.press("ArrowLeft")
    page.keyboard.press("Escape")
    with page.expect_event("load", timeout=TMO):
        page.click("#btnLogout")
    assert not any(k.endswith(sara) for k in keys(page)), keys(page)
    assert who(page) is None
    login_ui(page, "علي")
    assert page.text_content("#progTxt") == "0/12"


def test_wrong_pin_and_taken_name_messages(device):
    api = FakeApi()
    api.add_student("سارة")
    page = device(api)
    page.wait_for_selector("#gClassSel", state="visible")
    page.fill("#gName", "سارة")
    page.select_option("#gClassSel", "7/3")
    page.fill("#gPin", "9999")
    page.click("#gGo")
    page.wait_for_function(
        "() => document.querySelector('#gErr').textContent.length > 0"
    )
    assert "غير صحيح" in page.inner_text("#gErr")
    page.click("#gMode")
    page.fill("#gPin", "1111")
    page.click("#gGo")
    page.wait_for_function(
        "() => document.querySelector('#gErr').textContent.includes('مسجّل')"
    )
    assert who(page) is None


def test_expired_session_reopens_the_gate_with_the_name(device):
    api = FakeApi()
    sid = api.add_student("سارة")
    seeds = {
        "jzh.who": {"sid": sid, "name": "سارة", "cls": "7/3"},
        f"jzh.sync.{sid}": {"version": 0, "epoch": 0, "t": {}, "settings": {}},
    }
    page = device(api, seeds=seeds)  # no session cookie in this context
    page.wait_for_selector("#gate:not([hidden])", timeout=TMO)
    assert page.input_value("#gName") == "سارة"
    assert "انتهت جلستك" in page.inner_text("#gErr")


def test_hostile_name_is_shown_as_text(device):
    api = FakeApi()
    page = device(api)
    login_ui(page, "<img src=x onerror=window.__xss=1>", register=True)
    assert page.evaluate("() => window.__xss") is None
    assert "<img" in page.inner_text("#hiName")


def test_guest_mode_only_reads_settings(device):
    api = FakeApi()
    api.classes = []  # no classes published -> legacy name-only gate
    page = device(api)
    page.wait_for_selector("#gate:not([hidden])")
    page.wait_for_timeout(300)
    assert (
        page.locator("#gClass").is_visible() and not page.locator("#gPin").is_visible()
    )
    page.fill("#gName", "ضيف")
    page.click("#gGo")
    page.keyboard.press("ArrowLeft")
    page.wait_for_timeout(2600)
    paths = {c[1] for c in api.calls}
    assert paths == {"s/settings"}, paths


def test_published_settings_reach_a_signed_in_student(device):
    api = FakeApi()
    api.add_student("سارة")
    api.config["7/3"] = {"vis": {"gate.film": 0}}
    page = device(api)
    login_ui(page, "سارة")
    assert page.text_content("#progTxt") == "0/11"
