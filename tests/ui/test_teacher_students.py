"""The teacher's «الطلاب» tab, publishing settings, and certificate approval."""

from fakeapi import FakeApi
from helpers import TMO, login_ui, unlock_teacher


def open_students(device, api):
    page = device(api, hash="#teacher")
    unlock_teacher(page)
    page.wait_for_selector("#v-teacher", state="visible", timeout=TMO)
    page.click('.ttab[data-t="students"]')
    page.wait_for_function(
        "() => document.querySelector('#stCount').textContent.includes('طالب')",
        timeout=TMO,
    )
    return page


def summary(visited, track=None, score=None, submitted=False):
    return {
        "visited": visited,
        "quizTrack": track,
        "quizScore": score,
        "submitted": submitted,
    }


def test_table_lists_students_and_escapes_names(device):
    api = FakeApi()
    a = api.add_student("<img src=x onerror=window.__xss=1>")
    b = api.add_student("علي", cls="8/1")
    api.progress[a]["summary"] = summary(5, "map", 80, True)
    api.progress[b]["summary"] = summary(2)
    page = open_students(device, api)
    rows = page.locator("#stTable tbody tr")
    assert rows.count() == 2
    assert page.evaluate("() => window.__xss") is None
    text = page.inner_text("#stTable")
    assert (
        "<img" in text and "5/12" in text and "MAP · 80٪ ✓" in text and "جديد" in text
    )
    page.select_option("#stCls", "8/1")
    page.wait_for_function(
        "() => document.querySelectorAll('#stTable tbody tr').length === 1", timeout=TMO
    )
    assert "علي" in page.inner_text("#stTable tbody")


def test_progress_ratio_follows_hidden_gates(device):
    api = FakeApi()
    sid = api.add_student("سارة")
    api.progress[sid]["summary"] = summary(12)
    page = device(
        api, hash="#teacher", seeds={"jzh.v1": {"vis": {"gate.film": 0, "gate.web": 0}}}
    )
    unlock_teacher(page)
    page.click('.ttab[data-t="students"]')
    page.wait_for_selector("#stTable tbody tr", timeout=TMO)
    assert "10/10" in page.inner_text("#stTable tbody")


def test_approving_a_certificate_opens_it_for_the_student(device):
    api = FakeApi()
    sid = api.add_student("سارة")
    teacher = open_students(device, api)
    teacher.click("#stTable .stcert")
    teacher.wait_for_function(
        "() => document.querySelector('#stTable .stcert').textContent.includes('معتمدة')",
        timeout=TMO,
    )
    assert sid in api.certs
    assert api.calls_to("POST", "t/certificate")[-1][2] == {"id": sid, "approved": True}
    # revoking takes a confirming second click
    teacher.click("#stTable .stcert")
    assert sid in api.certs
    teacher.click("#stTable .stcert")
    teacher.wait_for_function(
        "() => document.querySelector('#stTable .stcert').textContent.includes('اعتمد')",
        timeout=TMO,
    )
    assert sid not in api.certs


def test_student_cert_button_waits_for_approval(device, quiz_shape):
    from helpers import GATES, quiz_seed

    api = FakeApi()
    q = quiz_seed(quiz_shape, done_track="lap")
    sid = api.add_student(
        "سارة",
        state={
            "main": {"visited": {g: 1 for g in GATES}},
            "quiz": {k: q[k] for k in ("S", "B", "P", "PI", "AI") if k in q},
        },
    )
    page = device(api)
    login_ui(page, "سارة")
    btn = "document.querySelector('.cbgo').disabled"
    assert page.evaluate(f"() => {btn}") is True
    assert "بانتظار" in (page.get_attribute(".cbgo", "title") or "")
    api.certs.add(sid)
    page.reload()
    page.wait_for_function(f"() => !{btn}", timeout=TMO)
    page.click('.hub[data-hub="badges"] .hubhead')
    page.click(".cbgo")
    page.wait_for_selector("#v-cert", state="visible", timeout=TMO)


def test_cert_stays_shut_when_approved_but_a_live_gate_is_missing(device):
    api = FakeApi()
    sid = api.add_student("سارة", state={"main": {"visited": {"story": 1}}})
    api.certs.add(sid)
    page = device(api)
    login_ui(page, "سارة")
    assert page.evaluate("() => document.querySelector('.cbgo').disabled") is True


def test_detail_actions_reset_pin_and_delete(device):
    api = FakeApi()
    sid = api.add_student(
        "سارة", state={"main": {"notes": {"h1": "تأمّل معماري جميل"}}}
    )
    page = open_students(device, api)
    page.click("#stTable .stname")
    page.wait_for_selector("#stDetail .treport", timeout=TMO)
    assert "تأمّل معماري جميل" in page.inner_text("#stDetail .treport")
    page.fill("#stPin", "٧٧٧٧")
    page.click('#stDetail [data-a="reset-pin"]')
    page.wait_for_timeout(300)
    assert api.students[sid]["pin"] == "7777"
    page.click('#stDetail [data-a="delete"]')
    assert sid in api.students, "first click only asks for confirmation"
    page.click('#stDetail [data-a="delete"]')
    page.wait_for_selector("#stDetail", state="hidden", timeout=TMO)
    assert sid not in api.students


def test_publish_sends_board_settings_without_a_pin(device):
    api = FakeApi()
    page = device(
        api, hash="#teacher", seeds={"jzh.v1": {"vis": {"gate.film": 0}, "tpin": "old"}}
    )
    unlock_teacher(page)
    page.click('.ttab[data-t="tools"]')
    page.wait_for_function(
        "() => document.querySelectorAll('#pubCls option').length > 1", timeout=TMO
    )
    page.select_option("#pubCls", "7/3")
    page.click("#pubGo")
    page.wait_for_timeout(300)
    body = api.calls_to("PUT", "t/settings")[-1][2]
    assert body["cls"] == "7/3"
    assert set(body["config"]) == {"vis", "en", "hub", "pres", "ask", "res"}
    assert body["config"]["vis"] == {"gate.film": 0}


def test_classes_editor_saves_the_list(device):
    api = FakeApi()
    page = device(api, hash="#teacher")
    unlock_teacher(page)
    page.click('.ttab[data-t="tools"]')
    page.wait_for_function(
        "() => document.querySelector('#clsIn').value.includes('7/3')", timeout=TMO
    )
    page.fill("#clsIn", "9/1 | التاسع ١\n9/2")
    page.click("#clsSave")
    page.wait_for_timeout(300)
    assert api.classes == [
        {"code": "9/1", "label": "التاسع ١"},
        {"code": "9/2", "label": "9/2"},
    ]
