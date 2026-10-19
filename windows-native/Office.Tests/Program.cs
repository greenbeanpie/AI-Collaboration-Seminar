using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using Buwei.Windows.Core;

var tests = new List<(string, Func<Task>)>();
const string W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const string S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const string A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const string R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
tests.Add(("supported formats are modern and case insensitive", () =>
{
    foreach (var path in new[] { "a.docx", "a.XLSX", "a.Pptx" }) True(OfficeTextReader.IsSupported(path));
    foreach (var path in new[] { "a.doc", "a.xls", "a.ppt", "a.html", "a.docx.exe" }) True(!OfficeTextReader.IsSupported(path));
    return Task.CompletedTask;
}));
tests.Add(("DOCX paragraphs table rich runs header and immutable original", async () =>
{
    using var f = new Fixture(".docx"); f.Zip(("word/document.xml", $"<w:document xmlns:w='{W}'><w:body><w:p><w:r><w:t>中文</w:t></w:r><w:r><w:t xml:space='preserve'> text</w:t><w:tab/><w:t>more</w:t><w:br/><w:t>next</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>"), ("word/header1.xml", $"<w:hdr xmlns:w='{W}'><w:p><w:r><w:t>页眉</w:t></w:r></w:p></w:hdr>"));
    var before = SHA256.HashData(File.ReadAllBytes(f.Path)); var text = await OfficeTextReader.ReadAsync(f.Path);
    True(text.Contains("中文 text\tmore\nnext")); True(text.Contains("A\tB")); True(text.Contains("[header1.xml]\n页眉"));
    True(before.SequenceEqual(SHA256.HashData(File.ReadAllBytes(f.Path))));
}));
tests.Add(("XLSX sheet order shared rich inline sparse and formulas", async () =>
{
    using var f = new Fixture(".xlsx"); f.Workbook(
        $"<sst xmlns='{S}'><si><r><t>Shared</t></r><r><t> 中文</t></r></si></sst>",
        $"<worksheet xmlns='{S}'><sheetData><row r='1'><c r='A1' t='s'><v>0</v></c><c r='C1' t='inlineStr'><is><r><t>Inline</t></r><r><t> rich</t></r></is></c><c r='D1' t='b'><v>1</v></c><c r='E1'><f>1+1</f><v>2</v></c><c r='F1'><f>2+2</f></c></row><row r='2'><c r='B2'><v>42</v></c></row></sheetData></worksheet>");
    var text = await OfficeTextReader.ReadAsync(f.Path);
    True(text.IndexOf("[工作表: First]", StringComparison.Ordinal) < text.IndexOf("[工作表: Second]", StringComparison.Ordinal));
    True(text.Contains("Shared 中文\t\tInline rich\tTRUE\t2\t=2+2")); True(text.Contains("\n\t42")); True(text.Contains("Second body"));
}));
tests.Add(("PPTX presentation order and table cells", async () =>
{
    using var f = new Fixture(".pptx"); f.Zip(
        ("ppt/presentation.xml", $"<p:presentation xmlns:p='urn:p' xmlns:r='{R}'><p:sldIdLst><p:sldId id='20' r:id='second'/><p:sldId id='10' r:id='first'/></p:sldIdLst></p:presentation>"),
        ("ppt/_rels/presentation.xml.rels", Rels(("first", "slides/slide1.xml"), ("second", "slides/slide2.xml"))),
        ("ppt/slides/slide1.xml", $"<a:root xmlns:a='{A}'><a:p><a:r><a:t>First file</a:t></a:r></a:p></a:root>"),
        ("ppt/slides/slide2.xml", $"<a:root xmlns:a='{A}'><a:p><a:r><a:t>Second file</a:t></a:r></a:p><a:tbl><a:tr><a:tc><a:p><a:r><a:t>Left</a:t></a:r></a:p></a:tc><a:tc><a:p><a:r><a:t>Right</a:t></a:r></a:p></a:tc></a:tr></a:tbl></a:root>"));
    var text = await OfficeTextReader.ReadAsync(f.Path); True(text.IndexOf("Second file", StringComparison.Ordinal) < text.IndexOf("First file", StringComparison.Ordinal)); True(text.Contains("Left\tRight"));
}));
tests.Add(("invalid shared string index is rejected", async () =>
{
    using var f = new Fixture(".xlsx"); f.Workbook($"<sst xmlns='{S}'><si><t>one</t></si></sst>", $"<worksheet xmlns='{S}'><sheetData><row><c t='s'><v>99</v></c></row></sheetData></worksheet>");
    await Reject(() => OfficeTextReader.ReadAsync(f.Path));
}));
tests.Add(("nonstandard sharedStrings relationship resolves and sparse empty cells keep columns", async () =>
{
    using var f = new Fixture(".xlsx"); f.Zip(
        ("xl/workbook.xml", $"<workbook xmlns='{S}' xmlns:r='{R}'><sheets><sheet name='Custom' r:id='sheet'/></sheets></workbook>"),
        ("xl/_rels/workbook.xml.rels", $"<Relationships><Relationship Id='sheet' Target='worksheets/custom.xml'/><Relationship Id='strings' Type='{R}/sharedStrings' Target='text/custom.xml'/></Relationships>"),
        ("xl/text/custom.xml", $"<sst xmlns='{S}'><si/><si><t>Custom string</t></si></sst>"),
        ("xl/worksheets/custom.xml", $"<worksheet xmlns='{S}'><sheetData><row><c r='A1'/><c r='B1' t='s'><v>0</v></c><c r='D1' t='s'><v>1</v></c></row></sheetData></worksheet>"));
    True((await OfficeTextReader.ReadAsync(f.Path)).Contains("\n\t\t\tCustom string"));
}));
tests.Add(("excessive XML nesting rejects", async () =>
{
    using var f = new Fixture(".docx"); f.Zip(("word/document.xml", string.Concat(Enumerable.Repeat("<d>", 140)) + string.Concat(Enumerable.Repeat("</d>", 140))));
    await Reject(() => OfficeTextReader.ReadAsync(f.Path));
}));
foreach (var xml in new[] { "<broken>", "<!DOCTYPE document [<!ENTITY x SYSTEM 'file:///C:/Windows/win.ini'>]><document>&x;</document>", "<!DOCTYPE d [<!ENTITY x 'abc'>]><d>&x;</d>" })
{
    var value = xml; tests.Add(("malformed XML or DTD is rejected " + value[..Math.Min(25, value.Length)], async () => { using var f = new Fixture(".docx"); f.Zip(("word/document.xml", value)); await Reject(() => OfficeTextReader.ReadAsync(f.Path)); }));
}
tests.Add(("duplicate archive names and traversal entries rejected", async () =>
{
    using var f = new Fixture(".docx"); f.Zip(("word/document.xml", "<d/>"), ("word/document.xml", "<d/>")); await Reject(() => OfficeTextReader.ReadAsync(f.Path));
    f.Zip(("../outside.xml", "<d/>"), ("word/document.xml", "<d/>")); await Reject(() => OfficeTextReader.ReadAsync(f.Path));
}));
tests.Add(("missing body or malformed ZIP rejected", async () =>
{
    using var f = new Fixture(".docx"); f.Zip(("other.xml", "<d/>")); await Reject(() => OfficeTextReader.ReadAsync(f.Path));
    await File.WriteAllTextAsync(f.Path, "not a zip"); await Reject(() => OfficeTextReader.ReadAsync(f.Path));
}));
tests.Add(("external or escaping slide relationship is never fetched", async () =>
{
    foreach (var target in new[] { "https://evil.invalid/body.xml", "../../../outside.xml", "slides/missing.xml" })
    {
        using var f = new Fixture(".pptx"); f.Zip(("ppt/presentation.xml", $"<p xmlns:r='{R}'><sldId r:id='one'/></p>"), ("ppt/_rels/presentation.xml.rels", Rels(("one", target))));
        await Reject(() => OfficeTextReader.ReadAsync(f.Path));
    }
}));
tests.Add(("text expansion beyond output cap rejects without truncation", async () =>
{
    using var f = new Fixture(".docx"); f.Zip(("word/document.xml", $"<w:document xmlns:w='{W}'><w:p><w:r><w:t>" + new string('a', OfficeTextReader.MaxTextCharacters + 1) + "</w:t></w:r></w:p></w:document>"));
    await Reject(() => OfficeTextReader.ReadAsync(f.Path));
}));
tests.Add(("entry count cap rejects", async () =>
{
    using var f = new Fixture(".docx"); using (var zip = ZipFile.Open(f.Path, ZipArchiveMode.Create)) for (var i = 0; i <= OfficeTextReader.MaxEntries; i++) zip.CreateEntry("part" + i);
    await Reject(() => OfficeTextReader.ReadAsync(f.Path));
}));
tests.Add(("compressed oversized entry and aggregate cap reject", async () =>
{
    using var f = new Fixture(".docx");
    f.LargeZip(1, OfficeTextReader.MaxEntryBytes + 1); await Reject(() => OfficeTextReader.ReadAsync(f.Path));
    f.LargeZip(5, OfficeTextReader.MaxEntryBytes); await Reject(() => OfficeTextReader.ReadAsync(f.Path));
}));
tests.Add(("archive byte cap and cancellation reject before extraction", async () =>
{
    using var f = new Fixture(".docx"); using (var file = File.Create(f.Path)) file.SetLength(OfficeTextReader.MaxArchiveBytes + 1);
    await Reject(() => OfficeTextReader.ReadAsync(f.Path));
    f.Zip(("word/document.xml", "<d/>")); using var cancel = new CancellationTokenSource(); cancel.Cancel();
    await Reject(() => OfficeTextReader.ReadAsync(f.Path, cancel.Token));
}));
var failed = 0;
foreach (var (name, run) in tests) { try { await run(); Console.WriteLine("PASS " + name); } catch (Exception ex) { failed++; Console.Error.WriteLine("FAIL " + name + "\n" + ex); } }
Console.WriteLine($"{tests.Count - failed}/{tests.Count} Office extraction tests passed"); return failed == 0 ? 0 : 1;
static void True(bool value) { if (!value) throw new Exception("Assertion failed"); }
static async Task Reject(Func<Task> run) { try { await run(); } catch (Exception ex) when (ex is InvalidDataException or System.Xml.XmlException or OperationCanceledException or NotSupportedException) { return; } throw new Exception("Expected bounded extraction rejection"); }
static string Rels(params (string Id, string Target)[] relations) => "<Relationships xmlns='http://schemas.openxmlformats.org/package/2006/relationships'>" + string.Concat(relations.Select(r => $"<Relationship Id='{r.Id}' Target='{r.Target}'/>")) + "</Relationships>";
sealed class Fixture(string extension) : IDisposable
{
    public string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "Buwei-Office-" + Guid.NewGuid().ToString("N") + extension);
    public void Zip(params (string Name, string Body)[] parts)
    {
        File.Delete(Path); using var zip = ZipFile.Open(Path, ZipArchiveMode.Create);
        foreach (var (name, body) in parts) { using var writer = new StreamWriter(zip.CreateEntry(name, CompressionLevel.Fastest).Open(), new UTF8Encoding(false)); writer.Write(body); }
    }
    public void Workbook(string shared, string body)
    {
        const string s = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"; const string r = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
        Zip(("xl/workbook.xml", $"<workbook xmlns='{s}' xmlns:r='{r}'><sheets><sheet name='First' r:id='two'/><sheet name='Second' r:id='one'/></sheets></workbook>"),
            ("xl/_rels/workbook.xml.rels", "<Relationships><Relationship Id='one' Target='worksheets/sheet1.xml'/><Relationship Id='two' Target='worksheets/sheet2.xml'/></Relationships>"),
            ("xl/sharedStrings.xml", shared), ("xl/worksheets/sheet2.xml", body), ("xl/worksheets/sheet1.xml", $"<worksheet xmlns='{s}'><sheetData><row><c t='inlineStr'><is><t>Second body</t></is></c></row></sheetData></worksheet>"));
    }
    public void LargeZip(int count, long size)
    {
        File.Delete(Path); using var zip = ZipFile.Open(Path, ZipArchiveMode.Create); var chunk = new byte[1024 * 1024];
        for (var i = 0; i < count; i++) { using var stream = zip.CreateEntry("part" + i, CompressionLevel.Fastest).Open(); for (long remaining = size; remaining > 0; remaining -= chunk.Length) stream.Write(chunk, 0, (int)Math.Min(remaining, chunk.Length)); }
    }
    public void Dispose() => File.Delete(Path);
}
