# PDF.js browser verification

This is a development-only acceptance page. It imports the same renderPdfPages function used by the source-material flow and does not call the application API or an AI model. Vite serves this page directly during development; the production build has only the app's index.html entry and does not copy this directory.

## Generate sample PDFs

From the repository root, run the bundled Python runtime:

    /Users/hddhp/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 frontend/verification/generate_fixtures.py

The script writes two files to tmp/pdfs/:

- pdfjs-multipage-fixture.pdf: five pages with text and vector shapes.
- pdfjs-password-fixture.pdf: two encrypted pages. Its password is pdfjs-test; the current rendering helper does not accept a password, so selecting it should produce a visible PDF.js password error and exercise cleanup on a rejected loading task.

The PDFs are generated locally and are not committed.

## Start the browser page

    cd frontend
    npm run dev

Open http://localhost:5173/verification/pdf-render.html. Choose the multi-page PDF, enter a page from 1 to 5, and click 渲染所选页. Change the PDF page limit, maximum image edge, or maximum image bytes to check limit failures. The result shows the generated JPEG plus its pixel dimensions and byte size. Selecting the encrypted PDF checks the visible error path.

The relevant controls have stable automation selectors:

| Control | Selector |
| --- | --- |
| PDF input | #pdf-file / [data-testid="pdf-file"] |
| Page number | #page-number / [data-testid="page-number"] |
| PDF page limit | #max-pdf-pages / [data-testid="max-pdf-pages"] |
| JPEG long-edge limit | #page-image-max-edge / [data-testid="page-image-max-edge"] |
| JPEG byte limit | #page-image-max-bytes / [data-testid="page-image-max-bytes"] |
| Render button | #render-page / [data-testid="render-page"] |
| Status | #render-status / [data-testid="render-status"] |
| Error | #render-error / [data-testid="render-error"] |
| Result summary | #render-summary / [data-testid="render-summary"] |
| Result image | #rendered-image / [data-testid="rendered-image"] |
