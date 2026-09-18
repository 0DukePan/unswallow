"""Render docs/social-preview.png — the repository illustration and GitHub
social-preview image (1280x640, PNG).

Run from the repo root:
    python docs/social-preview.py

Uses Pillow and the platform UI fonts (Segoe UI / Consolas on Windows; DejaVu
fallbacks elsewhere). Run it after headline numbers change so the image and
the README stay in sync.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

WIDTH, HEIGHT = 1280, 640
OUT = Path(__file__).resolve().parent / "social-preview.png"

BG = "#0d1117"
CARD = "#161b22"
CARD_BORDER = "#30363d"
ACCENT = "#2ea043"
TITLE = "#f0f6fc"
PROSE = "#9aa4b2"
CODE = "#c9d1d9"
RED = "#f85149"
GREEN = "#3fb950"
AMBER = "#d29922"
BLUE = "#58a6ff"
MUTED = "#7d8590"

FONT_CANDIDATES = {
    "bold": ["C:/Windows/Fonts/segoeuib.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"],
    "regular": ["C:/Windows/Fonts/segoeui.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"],
    "mono_bold": ["C:/Windows/Fonts/consolab.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"],
}


def load(kind: str, size: int) -> ImageFont.FreeTypeFont:
    for candidate in FONT_CANDIDATES[kind]:
        path = Path(candidate)
        if path.exists():
            return ImageFont.truetype(str(path), size)
    raise SystemExit("no usable font found for {!r}".format(kind))


def draw_centered(draw: ImageDraw.ImageDraw, segments, y: int) -> None:
    width = sum(draw.textlength(text, font=font) for text, font, _ in segments)
    x = (WIDTH - width) / 2
    for text, font, color in segments:
        draw.text((x, y), text, font=font, fill=color, anchor="lm")
        x += draw.textlength(text, font=font)


def main() -> int:
    image = Image.new("RGB", (WIDTH, HEIGHT), BG)
    draw = ImageDraw.Draw(image)

    bold_112 = load("bold", 112)
    regular_38 = load("regular", 38)
    semibold_28 = load("bold", 28)
    regular_30 = load("regular", 30)
    mono_30 = load("mono_bold", 30)
    regular_26 = load("regular", 26)

    draw.rectangle((0, 0, WIDTH, 8), fill=ACCENT)

    draw.text((WIDTH / 2, 140), "unswallow", font=bold_112, fill=TITLE, anchor="mm")
    draw.text(
        (WIDTH / 2, 222),
        "Detect and recover tool calls trapped in reasoning channels",
        font=regular_38,
        fill=PROSE,
        anchor="mm",
    )

    draw.rounded_rectangle((170, 272, 1110, 492), radius=18, fill=CARD, outline=CARD_BORDER, width=2)

    rows = [
        ("BEFORE", RED, "tool_calls: [], finish_reason: stop"),
        ("AFTER", GREEN, "tool_calls: [get_weather(\u2026)]"),
        ("GATED", AMBER, "quoted / rehearsal calls withheld"),
    ]
    label_column = max(draw.textlength(label, font=mono_30) for label, _, _ in rows) + 46
    label_x, body_x = 216, 216 + label_column
    for index, (label, color, body) in enumerate(rows):
        y = 316 + index * 60
        draw.text((label_x, y), label, font=mono_30, fill=color, anchor="lm")
        draw.text((label_x + draw.textlength(label, font=mono_30) + 18, y), "\u2192", font=mono_30, fill=MUTED, anchor="lm")
        draw.text((body_x, y), body, font=mono_30, fill=CODE, anchor="lm")

    draw_centered(
        draw,
        [
            ("35/35", semibold_28, TITLE),
            (" fixtures", regular_30, MUTED),
            ("  \u00b7  ", regular_30, CARD_BORDER),
            ("100%", semibold_28, TITLE),
            (" detection recall", regular_30, MUTED),
            ("  \u00b7  ", regular_30, CARD_BORDER),
            ("0", semibold_28, TITLE),
            (" unsafe recoveries", regular_30, MUTED),
            ("  \u00b7  ", regular_30, CARD_BORDER),
            ("exact TS \u2194 Python parity", regular_30, MUTED),
        ],
        528,
    )
    draw_centered(
        draw,
        [
            ("vLLM", regular_26, BLUE),
            ("  \u00b7  ", regular_26, CARD_BORDER),
            ("SGLang", regular_26, BLUE),
            ("  \u00b7  ", regular_26, CARD_BORDER),
            ("llama.cpp", regular_26, BLUE),
            ("  \u00b7  ", regular_26, CARD_BORDER),
            ("TypeScript + Python  \u00b7  Zero runtime dependencies  \u00b7  MIT", regular_26, MUTED),
        ],
        578,
    )

    image.save(OUT, format="PNG", optimize=True)
    print("wrote {} ({:.1f} KB)".format(OUT, OUT.stat().st_size / 1024))
    return 0


if __name__ == "__main__":
    sys.exit(main())
