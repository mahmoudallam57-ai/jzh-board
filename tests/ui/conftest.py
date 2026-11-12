import pytest
from playwright.sync_api import sync_playwright

from helpers import ROOT, enter_gate, seed_script, start_server

DESKTOP = {"width": 1280, "height": 900}
MOBILE = {"width": 390, "height": 844}
BANKS = ["mcq", "tf", "sort", "img", "text", "essay"]


@pytest.fixture(scope="session")
def base_url():
    srv, url = start_server(ROOT)
    yield url
    srv.shutdown()


@pytest.fixture(scope="session")
def browser():
    with sync_playwright() as p:
        b = p.chromium.launch()
        yield b
        b.close()


@pytest.fixture
def app(browser, base_url):
    """Factory: app(seeds=None, viewport=DESKTOP, enter=True, hash="") -> Page.

    Every call opens a fresh browser context (empty storage).  `seeds` maps localStorage
    keys to JSON values written before the page boots.  With enter=True the student entry
    gate is passed first (the normal path for every test that is not about the gate)."""
    contexts = []

    def make(seeds=None, viewport=DESKTOP, enter=True, hash=""):
        ctx = browser.new_context(viewport=viewport, locale="ar")
        ctx.set_default_timeout(5000)
        contexts.append(ctx)
        if seeds:
            ctx.add_init_script(seed_script(seeds))
        page = ctx.new_page()
        page.goto(base_url + hash)
        if enter:
            enter_gate(page)
        return page

    yield make
    for c in contexts:
        c.close()


@pytest.fixture(scope="session")
def quiz_shape(browser, base_url):
    """{track: {bank: item_count}} read once from the booklet data."""
    ctx = browser.new_context(viewport=DESKTOP)
    page = ctx.new_page()
    page.goto(base_url)
    shape = page.evaluate(
        "(banks) => Object.fromEntries(TORDER.map(t => [t, Object.fromEntries("
        "banks.map(b => [b, TRACKS[t][b].length]))]))",
        BANKS,
    )
    ctx.close()
    return shape


@pytest.fixture
def device(browser, base_url):
    """Factory: device(api, seeds=None, viewport=DESKTOP, hash="") -> Page wired to a FakeApi.

    Each call is a separate browser context (a separate device) with its own session."""
    contexts = []

    def make(api, seeds=None, viewport=DESKTOP, hash=""):
        ctx = browser.new_context(viewport=viewport, locale="ar")
        ctx.set_default_timeout(5000)
        contexts.append(ctx)
        api.install(ctx)
        if seeds:
            ctx.add_init_script(seed_script(seeds))
        page = ctx.new_page()
        page.goto(base_url + hash)
        return page

    yield make
    for c in contexts:
        c.close()
