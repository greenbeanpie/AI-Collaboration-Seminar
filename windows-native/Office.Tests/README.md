# Modern Office extraction tests

```powershell
dotnet run --project windows-native/Office.Tests/Buwei.Windows.Office.Tests.csproj -c Release
```

`OfficeTextReader.IsSupported(path)` accepts DOCX/XLSX/PPTX (case insensitive). `ReadAsync(path, cancellationToken)` returns bounded plain text; source files remain untouched. No HTML, WebView, executable Office automation, external entity loading or network fetches.

DOCX extracts main paragraphs/tables plus labelled headers, footers and notes. XLSX follows workbook sheet order, concatenates rich shared/inline strings, preserves sparse column alignment with tabs, emits stored cell values and cached formula results (formula text if uncached). Excel number/date formatting, charts, images, formulas evaluation and layout are outside text extraction. PPTX follows presentation slide ordering and extracts text/table cells. Text is suitable for a native text preview and AI source body; it does not assert visual fidelity.

Limits: archive 64 MiB, 4096 ZIP entries/relationships, each expanded entry 32 MiB, total declared/actually read expanded bytes 128 MiB, final text and shared-string text each 2 million characters, 100000 shared strings, XML depth 128. Archives exceeding limits fail explicitly; no silently truncated output. DTDs/entities, archive traversal paths, duplicate entries, missing relationships, invalid shared string indexes and malformed XML fail explicitly. Tests create only local synthetic packages and check source hashes.
