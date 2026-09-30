#!/usr/bin/env python3
"""Generate local PDF.js browser verification samples under tmp/pdfs."""

from argparse import ArgumentParser
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.pdfencrypt import StandardEncryption
from reportlab.pdfgen import canvas


def draw_fixture_page(pdf: canvas.Canvas, page_number: int, page_count: int) -> None:
    width, height = A4
    accent = (colors.HexColor("#175bc1"), colors.HexColor("#19806a"), colors.HexColor("#a44b25"))[(page_number - 1) % 3]
    pdf.setFillColor(colors.HexColor("#f3f6fa"))
    pdf.rect(0, 0, width, height, stroke=0, fill=1)

    pdf.setFillColor(accent)
    pdf.roundRect(42, height - 118, width - 84, 64, 12, stroke=0, fill=1)
    pdf.setFillColor(colors.white)
    pdf.setFont("Helvetica-Bold", 18)
    pdf.drawString(60, height - 91, "PDF.js browser verification fixture")
    pdf.setFont("Helvetica", 11)
    pdf.drawString(60, height - 109, "Page %d of %d" % (page_number, page_count))

    pdf.setFillColor(colors.HexColor("#182638"))
    pdf.setFont("Helvetica-Bold", 15)
    pdf.drawString(48, height - 164, "Text and vector rendering check")
    pdf.setFont("Helvetica", 11)
    pdf.drawString(48, height - 187, "This sample includes selectable text, colored shapes, lines, and page labels.")
    pdf.drawString(48, height - 205, "The page number changes so multi-page navigation can be checked visually.")

    pdf.setStrokeColor(colors.HexColor("#8694a5"))
    pdf.setLineWidth(1)
    pdf.line(48, height - 225, width - 48, height - 225)

    pdf.setFillColor(colors.HexColor("#dbe8fa"))
    pdf.roundRect(48, height - 376, 218, 110, 14, stroke=0, fill=1)
    pdf.setFillColor(accent)
    pdf.circle(94, height - 322, 29, stroke=0, fill=1)
    pdf.setFillColor(colors.HexColor("#182638"))
    pdf.setFont("Helvetica-Bold", 12)
    pdf.drawString(137, height - 314, "Vector badge %02d" % page_number)
    pdf.setFont("Helvetica", 10)
    pdf.drawString(137, height - 334, "JPEG output should stay sharp.")

    pdf.setFillColor(colors.HexColor("#f7d38a"))
    pdf.rect(300, height - 376, 154, 110, stroke=0, fill=1)
    pdf.setStrokeColor(colors.HexColor("#a44b25"))
    pdf.setLineWidth(4)
    pdf.line(316, height - 350, 438, height - 350)
    pdf.line(316, height - 371, 438, height - 371)
    pdf.line(316, height - 329, 438, height - 329)

    for row in range(4):
        y = height - 435 - row * 34
        pdf.setFillColor(accent if row == page_number % 4 else colors.HexColor("#dce3eb"))
        pdf.roundRect(48, y, 18, 18, 4, stroke=0, fill=1)
        pdf.setFillColor(colors.HexColor("#344256"))
        pdf.setFont("Helvetica", 10)
        pdf.drawString(78, y + 5, "Fixture content row %d on page %d" % (row + 1, page_number))

    pdf.setStrokeColor(colors.HexColor("#c6ced8"))
    pdf.line(48, 56, width - 48, 56)
    pdf.setFillColor(colors.HexColor("#536273"))
    pdf.setFont("Helvetica", 9)
    pdf.drawString(48, 40, "Generated locally for browser-only PDF.js acceptance.")
    pdf.drawRightString(width - 48, 40, "Sample page %d" % page_number)
    pdf.showPage()


def create_pdf(path: Path, page_count: int, password: str | None = None) -> None:
    encrypt = StandardEncryption(password, canPrint=1) if password else None
    pdf = canvas.Canvas(str(path), pagesize=A4, encrypt=encrypt)
    for page_number in range(1, page_count + 1):
        draw_fixture_page(pdf, page_number, page_count)
    pdf.save()


def main() -> None:
    default_output = Path(__file__).resolve().parents[2] / "tmp" / "pdfs"
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=default_output)
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)

    multi_page = args.output_dir / "pdfjs-multipage-fixture.pdf"
    encrypted = args.output_dir / "pdfjs-password-fixture.pdf"
    create_pdf(multi_page, page_count=5)
    create_pdf(encrypted, page_count=2, password="pdfjs-test")
    print("Created " + str(multi_page))
    print("Created " + str(encrypted) + " (password: pdfjs-test)")


if __name__ == "__main__":
    main()
