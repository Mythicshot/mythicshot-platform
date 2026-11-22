"""Draws the wordmark, the product's name beside the mark, as two PNG pictures.

The name is "MYTHICSHOT" in Cinzel at weight 600 with 0.06em of letter-spacing and the
font's own pair kerning, as the brand sets it, drawn at three times the size the pages show
(20 pixels on a 24-pixel line there, so 60 on 72 here) in two colourways on a transparent
ground: the brand's gold for dark grounds and its ink (the text colour) for light ones,
the values of the `wordmark` token in src/brand-tokens.ts. The pages show it through
src/brand.ts; the platform serves no font for it.

    python scripts/build-wordmark.py [out-dir]

writes wordmark-dark.png and wordmark-light.png into out-dir (default src/brand-files/).
The same font gives the same bytes on every run: no metadata, no time, a fixed zlib level.
Needs Pillow with FreeType (the font's weight axis is set through it); Pillow without Raqm
applies no GPOS kerning, so the kerning is read from the font by scripts/font_kerning.py.
"""
import os
import sys
import zlib

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from font_kerning import Font  # noqa: E402

# The published variable font, unchanged and renamed, with its licence beside it. It is an
# input of this script only: the platform does not serve it.
FONT = os.path.join(HERE, "wordmark", "Cinzel-VariableFont_wght.ttf")
TEXT = "MYTHICSHOT"
SCALE = 3
SIZE = 20 * SCALE          # font size, pixels
LINE = 24 * SCALE          # line height, pixels
WEIGHT = 600
TRACKING = 0.06            # em
COLOURS = {"dark": "#f5b841", "light": "#1d1828"}


def rgb(hex_colour):
    return tuple(int(hex_colour[i:i + 2], 16) for i in (1, 3, 5))


def layout():
    """Each letter's pen position, the picture's width, and the baseline."""
    font = ImageFont.truetype(FONT, SIZE, layout_engine=ImageFont.Layout.BASIC)
    font.set_variation_by_axes([WEIGHT])
    shaper = Font(FONT)
    coords = shaper.normalise([WEIGHT])
    unit = SIZE / shaper.units_per_em()
    glyphs = [shaper.glyph_id(c) for c in TEXT]
    x, pens = 0.0, []
    for i, ch in enumerate(TEXT):
        pens.append(x)
        x += font.getlength(ch)
        if i + 1 < len(TEXT):
            x += shaper.pair_x_advance(glyphs[i], glyphs[i + 1], coords) * unit + TRACKING * SIZE
    # As a browser lays out a line: the half-leading above the font's ascent puts the baseline.
    ascent, descent = font.getmetrics()
    baseline = (LINE - (ascent + descent)) / 2 + ascent
    width = -(-int(round(x * 1000)) // (SCALE * 1000)) * SCALE  # whole display pixels
    return font, pens, width, baseline


def draw(colour):
    font, pens, width, baseline = layout()
    mask = Image.new("L", (width, LINE), 0)
    pen = ImageDraw.Draw(mask)
    for ch, x in zip(TEXT, pens):
        pen.text((x, baseline), ch, fill=255, font=font, anchor="ls")
    picture = Image.new("RGBA", (width, LINE), rgb(colour) + (0,))
    picture.putalpha(mask)
    return picture


def png(picture):
    """The picture as PNG bytes: IHDR, one IDAT, IEND; nothing else, so the bytes depend on the pixels alone."""
    width, height = picture.size
    raw = b"".join(b"\x00" + picture.tobytes()[y * width * 4:(y + 1) * width * 4] for y in range(height))
    def chunk(kind, data):
        return len(data).to_bytes(4, "big") + kind + data + zlib.crc32(kind + data).to_bytes(4, "big")
    header = width.to_bytes(4, "big") + height.to_bytes(4, "big") + bytes([8, 6, 0, 0, 0])
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "src", "brand-files")
    for scheme, colour in COLOURS.items():
        path = os.path.join(out, f"wordmark-{scheme}.png")
        with open(path, "wb") as f:
            f.write(png(draw(colour)))
        print(f"wrote {os.path.normpath(path)}")


if __name__ == "__main__":
    main()
