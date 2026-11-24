# Synthetic Library fixtures

These files contain invented data and are safe for disposable local accounts. `generate.py` regenerates DOCX/XLSX/PPTX, chart image, interactive/isolation HTML, Markdown, script and damaged document fixtures. It requires Python with python-docx 1.2.0, openpyxl 3.1.5, python-pptx 1.0.2 and Pillow 12.0.0. No external assets are referenced except deliberate blocked URLs in the isolation probe.

- `report.docx`: CJK, header/footer, page break, table and image.
- `budget.xlsx`: merged/styled cells, two worksheets, chart, stored formula results and deliberately absent results.
- `slides.pptx`: three slides, CJK text, image, chart and table.
- `dashboard.html`: self-contained JavaScript counter.
- `security.html`: parent, cookie, external fetch and external navigation probes.
- `encrypted.docx`: password-protected DOCX generated from report.docx with msoffcrypto-tool 5.4.2; fixture password `preview-test`.
- `compatibility.rtf`: exercises explicit compatibility conversion without enabling the optional direct RTF renderer.
- `corrupt.docx`: deliberately invalid document for recovery UX.
- `report.doc`, when present: locally generated with LibreOffice from report.docx for legacy recovery testing.

Real converter tests also generate ODF, legacy DOC/XLS/PPT and modern DOCX/XLSX/PPTX variants in temporary directories: `RUN_OFFICE_PREVIEW_TESTS=1 npx vitest run --project server apps/server/test/office-preview.integration.test.ts`.
