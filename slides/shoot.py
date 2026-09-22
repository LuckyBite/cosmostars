"""Снимки пульта для доклада.

Скриншоты в докладе — не украшение: жюри смотрит на них, пока докладчик называет
числа. Поэтому они снимаются скриптом с живого сервиса, а не собираются руками:
пересняты одной командой в любой момент, и на них ровно то состояние, которое
названо в подписи, с теми же числами, что печатает sweep.

Состояния набираются не кликами по меню, а маршрутами экрана «Показ» — теми же,
которыми пользуется жюри. Поэтому снимок и живой показ не могут разойтись.

    py -3 slides/shoot.py                  # сервис на 127.0.0.1:8000
    py -3 slides/shoot.py http://хост:порт
"""
import json
import pathlib
import sys
import urllib.request

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000"
OUT = pathlib.Path(__file__).parent / "shots"
OUT.mkdir(exist_ok=True)

# Маршрут «Показа» → снимки, которые с него снимаются. Экран указывается меткой
# в рельсе; None — оставить тот, который маршрут открыл сам.
# Кроп — снимок одного блока, а не всего окна. На слайде нужен именно блок:
# уменьшенное до колонки окно целиком читается только с первого ряда.
CROPS = {
    "02-shift-p02": [(".verdict-bar", "crop-verdict"),
                     (".metrics", "crop-metrics"),
                     ('.card:has-text("Потолок выполнимости")', "crop-ceiling"),
                     ('.card:has-text("Требует внимания")', "crop-attention")],
    "07-jobs-why": [('.card:has-text("Разбор JOB")', "crop-explain")],
    "10-shift-p04": [(".metrics", "crop-metrics-p04"),
                     (".verdict-bar", "crop-verdict-p04")],
}

PLAN = [
    ("Результат смены и потолок выполнимости", [
        (None, "02-shift-p02"),
        ("Полотно", "03-canvas-p02"),
        ("Аппараты", "04-sats"),
    ]),
    ("Новые сведения не переписывают прошлое", [
        (None, "05-canvas-fog"),
    ]),
    ("Работа при изменениях обстановки", [
        (None, "06-shift-events"),
    ]),
    ("Почему задание не вышло", [
        (None, "07-jobs-why"),
    ]),
    ("Две цели управления из одного состояния", [
        (None, "08-branches-goals"),
    ]),
    ("Наш планировщик против простого правила", [
        (None, "09-branches-baseline"),
    ]),
    ("Поведение при перегрузке", [
        (None, "10-shift-p04"),
    ]),
]


def shot(page, name, settle=900):
    page.wait_for_timeout(settle)
    page.screenshot(path=str(OUT / f"{name}.png"))
    print("  ", name)
    for selector, crop in CROPS.get(name, []):
        node = page.locator(selector).first
        if node.count():
            node.screenshot(path=str(OUT / f"{crop}.png"))
            print("    ", crop)


def rail(page, label):
    page.locator(".rail-item", has_text=label).first.click()
    page.wait_for_timeout(1000)


def route(page, title):
    """Запустить маршрут «Показа» и дождаться, пока он отпустит кнопку."""
    rail(page, "Показ")
    card = page.locator("article", has_text=title).first
    card.get_by_role("button", name="Показать").click()
    page.wait_for_selector(".rail-item[aria-current]", timeout=120_000)
    for _ in range(120):
        page.wait_for_timeout(1000)
        if page.locator(".rail-item", has_text="Показ").first.get_attribute("aria-current") is None:
            return
    raise TimeoutError(f"маршрут не завершился: {title}")


def daystrip(base):
    """Окна контакта по шагам — тем же API, что и пульт.

    На втором слайде полоса суток должна быть настоящей: 458 окон на 288 шагов
    и не больше двух передач одновременно — это и есть дефицит, о котором идёт
    речь. Числа кладутся рядом с колодой, чтобы она открывалась без сервиса.
    """
    def post(path, body):
        req = urllib.request.Request(base + path, data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
        return json.load(urllib.request.urlopen(req))

    run = post("/api/runs", {"scenario_key": "P02_shift", "goal": "priority",
                             "planner": "cosmostars"})
    contacts = json.load(urllib.request.urlopen(f"{base}/api/runs/{run['run_id']}/contacts"))
    steps = contacts["total_steps"]
    supply = [0] * steps
    for item in contacts["items"]:
        for first, last in item["downlink"]:
            for step in range(first, min(last, steps)):
                supply[step] += 1
    out = OUT.parent / "deck-data.js"
    out.write_text("\n".join([
        "/* Сгенерировано: py -3 slides/shoot.py. Правится пересъёмкой, не руками. */",
        "window.DECK_DATA = {",
        "  scenario: 'P02_shift',",
        f"  steps: {steps},",
        f"  windows: {sum(supply)},",
        "  limit: 2,",
        f"  supply: {json.dumps(supply)}",
        "};",
        "",
    ]), encoding="utf-8")
    print("   deck-data.js:", sum(supply), "окон на", steps, "шагов")


with sync_playwright() as p:
    browser = p.chromium.launch(channel="msedge", headless=True)
    page = browser.new_context(viewport={"width": 1600, "height": 1000},
                               device_scale_factor=2,
                               color_scheme="dark").new_page()
    page.goto(BASE, wait_until="networkidle")
    shot(page, "01-start")

    # В пульт нужно войти хоть какой-нибудь сменой: экран «Показ» живёт внутри.
    page.get_by_role("button", name="Открыть смену").click()
    page.wait_for_selector(".rail", timeout=120_000)

    for title, shots in PLAN:
        print(title)
        route(page, title)
        for tab, name in shots:
            if tab:
                rail(page, tab)
            shot(page, name)

    print("Проверка расчёта в браузере")
    route(page, "Проверка расчёта в браузере")
    page.get_by_role("button", name="Проверить текущую смену").click()
    page.wait_for_timeout(6000)
    shot(page, "11-verify")

    rail(page, "Показ")
    shot(page, "12-show")

    browser.close()

daystrip(BASE)
print("готово:", OUT)
