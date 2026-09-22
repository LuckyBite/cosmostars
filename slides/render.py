"""Колода в PDF и покадрово.

Живой доклад показывается из браузера — там анимация и заметки. Но на площадке
регулярно просят прислать файл заранее, и с чужого ноутбука доклад включат из
него. Поэтому та же колода выкладывается одним PDF и отдельными кадрами, и
делается это скриптом: иначе файл разъедется с html после первой же правки.

PDF печатается из режима `deck.html?print`, где колода развёрнута в столбик по
кадру на страницу и анимация выключена. Текст в нём остаётся текстом — его
можно искать и копировать, — а не картинкой на весь слайд.

    py -3 slides/render.py                   # сервер слайдов на 8780
    py -3 slides/render.py http://хост/deck.html
"""
import pathlib
import sys

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8780/deck.html"
HERE = pathlib.Path(__file__).parent
OUT = HERE / "export"
OUT.mkdir(exist_ok=True)
PDF = HERE / "Cosmostars-защита.pdf"

with sync_playwright() as p:
    browser = p.chromium.launch(channel="msedge", headless=True)
    context = browser.new_context(viewport={"width": 1920, "height": 1080},
                                  device_scale_factor=1,
                                  color_scheme="dark",
                                  reduced_motion="reduce")
    page = context.new_page()

    page.goto(BASE + "?print", wait_until="networkidle")
    page.wait_for_timeout(1500)
    page.pdf(path=str(PDF), width="1920px", height="1080px",
             print_background=True, margin={"top": "0", "bottom": "0",
                                            "left": "0", "right": "0"})
    print("PDF:", PDF)

    # Отдельные кадры — для записки, для переписки и на случай, когда нужен
    # один слайд, а не вся колода.
    page.goto(BASE, wait_until="networkidle")
    page.wait_for_timeout(800)
    total = page.evaluate("document.querySelectorAll('.slide').length")
    for i in range(total):
        page.evaluate("i => { location.hash = String(i + 1); location.reload(); }", i)
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(600)
        label = page.evaluate("document.querySelector('.slide.live').dataset.label || ''")
        page.screenshot(path=str(OUT / f"{i + 1:02d}.png"))
        print(f"  {i + 1:02d}  {label}")

    browser.close()

print("кадры:", OUT)
