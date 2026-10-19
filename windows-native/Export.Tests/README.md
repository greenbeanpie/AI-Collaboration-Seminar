# Project semantic export tests

```powershell
dotnet run --project windows-native/Export.Tests/Buwei.Windows.Export.Tests.csproj -c Release
```

Uses the actual `/projects/{projectId}/export-bundle` field names, synthetic identifiers/content and official MIT-licensed PDFsharp 6.2.4. Root Core must reference PDFsharp 6.2.4 and patched System.Security.Cryptography.Pkcs 10.0.13 (PDFsharp's default 8.0.1 has NuGet advisories). No audit warning suppression. Version 6.5.0 introduces AGPL/commercial activation requirements and is intentionally excluded.

`ProjectExport.Markdown(bundle)` renders semantic sections with original identifiers, fixed-version references, availability flags and nested reports. Unknown fields remain present. The original JsonNode is unchanged. `PdfAsync(bundle,path,ct)` uses an installed Windows simhei.ttf or Deng.ttf (never redistributed), checks OS/2 embedding flags, embeds Unicode font subsets, uses measured grapheme wrapping, A4 pagination and page numbers. It refuses existing destinations, preserves preexisting `.partial` files, writes its own `.partial` then atomically renames, and removes its own partial on failure/cancellation. Missing or restricted installed font fails explicitly.

These are source/format checks, not authenticated export UI acceptance. Font resolver is global in PDFsharp; another component initializing an incompatible resolver causes an explicit error. Max text 8 million characters, XML/JSON nesting 32, PDF 1000 pages; no truncation. Unsupported glyphs outside installed font coverage remain a font limitation.

For CLI verification, set `BUWEI_EXPORT_TEST_ARTIFACT` to a fresh absolute PDF path before running. The harness retains its synthetic multipage output there. Inspect with `pdfinfo`, `pdftotext`, and render pages with `pdftoppm`; no browser or ComputerUse is needed.
