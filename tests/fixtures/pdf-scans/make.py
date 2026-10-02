"""Writes the scanned pages the tests of the PDF viewer draw: one PDF of one page for each kind of picture that
pdf.js decodes with a decoder of its own, a CCITT fax (Group 4) page, a JBIG2 page and a JPEG 2000 page.

Each page is a picture covering the whole page: lines of text, and a box filled with ink from (40, 40) to (200, 120)
in pixels of the picture, black on the black-and-white pages and red on the JPEG 2000 one. The JBIG2 page holds one
generic region coded with MMR, which is the Group 4 coding inside JBIG2.

    python3 make.py <folder> [--dpi n]

writes ccitt.pdf, jbig2.pdf and jpx.pdf into the folder. At the default of 72 dpi the page is 400 x 560 pixels,
which the tests use; --dpi 300 writes an A4 page scanned at 300 dpi, for measuring. Needs Pillow built with
libtiff and OpenJPEG, as its wheels are.
"""

import io
import struct
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

A4_PT = (595, 842)


def page_pixels(dpi: int) -> tuple[int, int]:
    if dpi == 72:
        return 400, 560
    return round(A4_PT[0] * dpi / 72), round(A4_PT[1] * dpi / 72)


def draw_page(mode: str, size: tuple[int, int], dpi: int) -> Image.Image:
    """The scanned page: white paper, lines of text, and the box of ink."""
    ink = 1 if mode == "1" else (0, 0, 0)
    image = Image.new(mode, size, 0 if mode == "1" else (255, 255, 255))
    draw = ImageDraw.Draw(image)
    scale = dpi / 72
    box_ink = ink if mode == "1" else (220, 30, 30)
    draw.rectangle((40 * scale, 40 * scale, 200 * scale - 1, 120 * scale - 1), fill=box_ink)
    font = ImageFont.load_default(size=max(8, round(10 * scale)))
    line = 0
    for y in range(round(140 * scale), size[1] - round(20 * scale), round(14 * scale)):
        draw.text((20 * scale, y), f"Line {line} of the scanned report, written to be read back by the viewer.", fill=ink, font=font)
        line += 1
    return image


def group4(image: Image.Image) -> bytes:
    """The Group 4 coding of a picture whose 1 bits are ink, as one strip: 0 bits are coded as white runs."""
    buffer = io.BytesIO()
    image.save(buffer, format="TIFF", compression="group4", tiffinfo={278: image.height})
    tiff = Image.open(io.BytesIO(buffer.getvalue()))
    offsets, counts = tiff.tag_v2[273], tiff.tag_v2[279]
    if len(offsets) != 1:
        raise SystemExit(f"the picture was coded in {len(offsets)} strips, not one")
    return buffer.getvalue()[offsets[0] : offsets[0] + counts[0]]


def jbig2(width: int, height: int, mmr: bytes) -> bytes:
    """A JBIG2 stream as a PDF embeds one: a page information segment, an immediate generic region coded with MMR, and
    the end of the page, with no file header (ITU-T T.88, 7.2 and annex D)."""

    def segment(number: int, kind: int, data: bytes) -> bytes:
        return struct.pack(">IBBBI", number, kind, 0, 1, len(data)) + data

    page = struct.pack(">IIIIBH", width, height, 0, 0, 1, 0)
    region = struct.pack(">IIIIB", width, height, 0, 0, 0) + bytes([1]) + mmr
    return segment(0, 48, page) + segment(1, 38, region) + segment(2, 49, b"")


def jpeg2000(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG2000", quality_mode="rates", quality_layers=[20])
    return buffer.getvalue()


def pdf(width_px: int, height_px: int, dpi: int, entries: str, data: bytes) -> bytes:
    """A PDF of one page that the picture covers."""
    width_pt, height_pt = width_px * 72 / dpi, height_px * 72 / dpi
    content = f"q {width_pt:.2f} 0 0 {height_pt:.2f} 0 0 cm /Im0 Do Q".encode()
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {width_pt:.2f} {height_pt:.2f}] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>".encode(),
        b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream",
        f"<< /Type /XObject /Subtype /Image /Width {width_px} /Height {height_px} {entries} /Length {len(data)} >>\nstream\n".encode() + data + b"\nendstream",
    ]
    out = bytearray(b"%PDF-1.5\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


def main() -> None:
    args = sys.argv[1:]
    if not args:
        raise SystemExit(__doc__)
    folder = Path(args[0])
    dpi = int(args[args.index("--dpi") + 1]) if "--dpi" in args else 72
    folder.mkdir(parents=True, exist_ok=True)
    width, height = page_pixels(dpi)

    bilevel = draw_page("1", (width, height), dpi)
    coded = group4(bilevel)
    ccitt = f"/ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns {width} /Rows {height} >>"
    (folder / "ccitt.pdf").write_bytes(pdf(width, height, dpi, ccitt, coded))
    (folder / "jbig2.pdf").write_bytes(pdf(width, height, dpi, "/ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /JBIG2Decode", jbig2(width, height, coded)))

    color = draw_page("RGB", (width, height), dpi)
    (folder / "jpx.pdf").write_bytes(pdf(width, height, dpi, "/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /JPXDecode", jpeg2000(color)))

    for name in ("ccitt.pdf", "jbig2.pdf", "jpx.pdf"):
        print(f"{name}: {(folder / name).stat().st_size:,} bytes")


main()
