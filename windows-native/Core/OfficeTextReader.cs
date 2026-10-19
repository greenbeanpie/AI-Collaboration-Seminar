using System.IO.Compression;
using System.Text;
using System.Xml;

namespace Buwei.Windows.Core;

/// <summary>Bounded modern Office body extraction. Stored values and text, not layout or rendered pages.</summary>
public static class OfficeTextReader
{
    public const long MaxArchiveBytes = 64 * 1024 * 1024;
    public const long MaxEntryBytes = 32 * 1024 * 1024;
    public const long MaxExpandedBytes = 128 * 1024 * 1024;
    public const int MaxEntries = 4096;
    public const int MaxTextCharacters = 2_000_000;
    public static bool IsSupported(string path) => Path.GetExtension(path).ToLowerInvariant() is ".docx" or ".xlsx" or ".pptx";

    public static async Task<string> ReadAsync(string path, CancellationToken ct = default)
    {
        if (!IsSupported(path)) throw new NotSupportedException("仅支持 DOCX、XLSX 和 PPTX 正文提取");
        ct.ThrowIfCancellationRequested();
        await using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 65536, FileOptions.Asynchronous | FileOptions.SequentialScan);
        if (file.Length > MaxArchiveBytes) throw new InvalidDataException("Office 文件超过 64 MiB 提取上限");
        using var archive = new ZipArchive(file, ZipArchiveMode.Read, leaveOpen: true);
        var package = new Package(archive, ct); var output = new Text();
        switch (Path.GetExtension(path).ToLowerInvariant())
        {
            case ".docx":
                await Paragraphs(package, "word/document.xml", output, false);
                // Ancillary text is labelled; embedded objects and their executable content are not opened.
                foreach (var part in package.Names.Where(n => n.StartsWith("word/", StringComparison.Ordinal) && (Path.GetFileName(n).StartsWith("header", StringComparison.Ordinal) || Path.GetFileName(n).StartsWith("footer", StringComparison.Ordinal) || n is "word/footnotes.xml" or "word/endnotes.xml") && n.EndsWith(".xml", StringComparison.Ordinal)).Order(StringComparer.Ordinal))
                { output.Add("\n[" + Path.GetFileName(part) + "]\n"); await Paragraphs(package, part, output, false); }
                break;
            case ".xlsx": await Workbook(package, output); break;
            case ".pptx":
                var relations = await Relationships(package, "ppt/_rels/presentation.xml.rels", "ppt/presentation.xml");
                using (var reader = package.Xml("ppt/presentation.xml"))
                {
                    var slide = 0;
                    while (await reader.ReadAsync())
                    {
                        package.Check(reader);
                        if (reader.NodeType != XmlNodeType.Element || reader.LocalName != "sldId") continue;
                        var id = reader.GetAttribute("id", "http://schemas.openxmlformats.org/officeDocument/2006/relationships") ?? reader.GetAttribute("id", "http://purl.oclc.org/ooxml/officeDocument/relationships");
                        if (id == null || !relations.TryGetValue(id, out var target)) throw new InvalidDataException("幻灯片关联缺失");
                        output.Add($"\n[幻灯片 {++slide}]\n"); await Paragraphs(package, target, output, true);
                    }
                }
                break;
        }
        return output.ToString().Trim();
    }

    private static async Task Paragraphs(Package package, string part, Text output, bool presentation)
    {
        using var reader = package.Xml(part); var inCell = 0; var paragraphHasText = false;
        while (await reader.ReadAsync())
        {
            package.Check(reader);
            var name = reader.LocalName;
            if (reader.NodeType == XmlNodeType.Element)
            {
                if (name == "tc" && !reader.IsEmptyElement) inCell++;
                if (name == "p") paragraphHasText = false;
                if (name == "t") { output.Add(await ElementText(reader, package.Token)); paragraphHasText = true; }
                if (name == "tab") output.Add("\t");
                if (name == "br" || !presentation && name == "cr") output.Add("\n");
            }
            else if (reader.NodeType == XmlNodeType.EndElement)
            {
                if (name == "p" && paragraphHasText) output.Add(inCell > 0 ? " " : "\n");
                if (name == "tc") { inCell--; output.TrimSpaces(); output.Add("\t"); }
                if (name == "tr") { output.TrimSpaces(); output.Add("\n"); }
            }
        }
    }

    private static async Task Workbook(Package package, Text output)
    {
        var relatedTypes = new Dictionary<string, string>(StringComparer.Ordinal);
        var relations = await Relationships(package, "xl/_rels/workbook.xml.rels", "xl/workbook.xml", relatedTypes);
        var shared = new List<string>(); var sharedCharacters = 0;
        var sharedPart = relatedTypes.FirstOrDefault(x => x.Key.EndsWith("/sharedStrings", StringComparison.Ordinal)).Value;
        sharedPart ??= package.Contains("xl/sharedStrings.xml") ? "xl/sharedStrings.xml" : null;
        if (sharedPart != null)
        {
            using var strings = package.Xml(sharedPart); Text? item = null;
            while (await strings.ReadAsync())
            {
                package.Check(strings);
                if (strings.NodeType == XmlNodeType.Element && strings.LocalName == "si")
                {
                    item = new(); if (shared.Count >= 100_000) throw new InvalidDataException("共享字符串数量超过上限");
                    if (strings.IsEmptyElement) { shared.Add(""); item = null; }
                }
                else if (strings.NodeType == XmlNodeType.Element && strings.LocalName == "t" && item != null) item.Add(await ElementText(strings, package.Token));
                else if (strings.NodeType == XmlNodeType.EndElement && strings.LocalName == "si" && item != null)
                {
                    sharedCharacters = checked(sharedCharacters + item.Length);
                    if (sharedCharacters > MaxTextCharacters || shared.Count >= 100_000) throw new InvalidDataException("共享文本超过提取上限");
                    shared.Add(item.ToString()); item = null;
                }
            }
        }
        using var workbook = package.Xml("xl/workbook.xml");
        while (await workbook.ReadAsync())
        {
            package.Check(workbook);
            if (workbook.NodeType != XmlNodeType.Element || workbook.LocalName != "sheet") continue;
            var id = workbook.GetAttribute("id", "http://schemas.openxmlformats.org/officeDocument/2006/relationships") ?? workbook.GetAttribute("id", "http://purl.oclc.org/ooxml/officeDocument/relationships");
            if (id == null || !relations.TryGetValue(id, out var target)) throw new InvalidDataException("工作表关联缺失");
            output.Add("\n[工作表: " + workbook.GetAttribute("name") + "]\n");
            await Sheet(package, target, shared, output);
        }
    }

    private static async Task Sheet(Package package, string part, List<string> shared, Text output)
    {
        using var reader = package.Xml(part); var column = 0; var targetColumn = 0; var type = ""; var cell = false; var inline = false;
        string? value = null; string? formula = null; var text = new Text();
        void Emit()
        {
            if (!cell) return;
            if (targetColumn <= column || targetColumn > 16384) throw new InvalidDataException("工作表列坐标无效");
            output.Add(new string('\t', targetColumn - column - (column == 0 ? 1 : 0))); column = targetColumn;
            var result = type == "inlineStr" ? text.ToString() : value ?? (formula == null ? "" : "=" + formula);
            if (type == "s")
            {
                if (!int.TryParse(value, out var index) || index < 0 || index >= shared.Count) throw new InvalidDataException("共享字符串索引无效");
                result = shared[index];
            }
            else if (type == "b") result = value == "1" ? "TRUE" : value == "0" ? "FALSE" : throw new InvalidDataException("布尔单元格无效");
            output.Add(result); cell = false;
        }
        while (await reader.ReadAsync())
        {
            package.Check(reader);
            if (reader.NodeType == XmlNodeType.Element)
            {
                switch (reader.LocalName)
                {
                    case "row": column = 0; if (reader.IsEmptyElement) output.Add("\n"); break;
                    case "c":
                        cell = true; type = reader.GetAttribute("t") ?? ""; value = formula = null; text = new(); inline = false;
                        var reference = reader.GetAttribute("r"); targetColumn = reference == null ? column + 1 : Column(reference);
                        if (reader.IsEmptyElement) Emit(); break;
                    case "is": if (cell) inline = !reader.IsEmptyElement; break;
                    case "v": if (cell) value = await ElementText(reader, package.Token); break;
                    case "f": if (cell) formula = await ElementText(reader, package.Token); break;
                    case "t": if (cell && inline) text.Add(await ElementText(reader, package.Token)); break;
                }
            }
            else if (reader.NodeType == XmlNodeType.EndElement)
            {
                if (reader.LocalName == "c") Emit();
                if (reader.LocalName == "is") inline = false;
                if (reader.LocalName == "row") output.Add("\n");
            }
        }
    }
    private static int Column(string reference)
    {
        var column = 0; var i = 0;
        while (i < reference.Length && reference[i] is >= 'A' and <= 'Z') { column = checked(column * 26 + reference[i++] - 'A' + 1); if (column > 16384) throw new InvalidDataException("列超出 XLSX 范围"); }
        if (i == 0 || i == reference.Length || reference[i..].Any(c => c is < '0' or > '9') || !int.TryParse(reference.AsSpan(i), out var row) || row is < 1 or > 1048576) throw new InvalidDataException("单元格坐标无效");
        return column;
    }
    private static async Task<string> ElementText(XmlReader reader, CancellationToken ct)
    {
        if (reader.IsEmptyElement) return "";
        var depth = reader.Depth; var text = new Text(); var chunk = new char[4096];
        while (await reader.ReadAsync())
        {
            ct.ThrowIfCancellationRequested();
            if (reader.Depth > 128) throw new InvalidDataException("Office XML 嵌套层级超过上限");
            if (reader.NodeType == XmlNodeType.EndElement && reader.Depth == depth) break;
            if (reader.NodeType is XmlNodeType.Text or XmlNodeType.CDATA or XmlNodeType.SignificantWhitespace or XmlNodeType.Whitespace)
            { int read; while ((read = await reader.ReadValueChunkAsync(chunk, 0, chunk.Length)) != 0) { ct.ThrowIfCancellationRequested(); text.Add(chunk.AsSpan(0, read)); } }
        }
        return text.ToString();
    }
    private static async Task<Dictionary<string, string>> Relationships(Package package, string part, string owner, Dictionary<string, string>? types = null)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal); using var reader = package.Xml(part);
        while (await reader.ReadAsync())
        {
            package.Check(reader);
            if (reader.NodeType != XmlNodeType.Element || reader.LocalName != "Relationship") continue;
            if (reader.GetAttribute("TargetMode") == "External") continue;
            var id = reader.GetAttribute("Id") ?? throw new InvalidDataException("关联 ID 缺失");
            var target = reader.GetAttribute("Target") ?? throw new InvalidDataException("关联目标缺失");
            if (target.Contains('\\') || target.Contains('?') || target.Contains('#') || target.Contains(':') || target.StartsWith("//", StringComparison.Ordinal)) throw new InvalidDataException("无效 Office 关联路径");
            var resolved = new List<string>();
            var segments = (target.StartsWith('/') ? target[1..] : owner[..(owner.LastIndexOf('/') + 1)] + target).Split('/');
            foreach (var segment in segments)
            {
                if (segment == "..") { if (resolved.Count == 0) throw new InvalidDataException("关联路径越界"); resolved.RemoveAt(resolved.Count - 1); }
                else if (segment is not ("" or ".")) resolved.Add(segment);
            }
            var name = string.Join('/', resolved);
            if (result.Count >= MaxEntries) throw new InvalidDataException("Office 关联数量超过上限");
            if (!package.Contains(name) || !result.TryAdd(id, name)) throw new InvalidDataException("关联目标不存在或 ID 重复");
            if (reader.GetAttribute("Type") is { } type && types != null) types.TryAdd(type, name);
        }
        return result;
    }
    private sealed class Text
    {
        private readonly StringBuilder builder = new(); public int Length => builder.Length;
        public void Add(string? value) { if (value != null) Add(value.AsSpan()); }
        public void Add(ReadOnlySpan<char> value) { if (builder.Length + value.Length > MaxTextCharacters) throw new InvalidDataException("Office 正文超过 200 万字符上限"); builder.Append(value); }
        public void TrimSpaces() { while (builder.Length > 0 && builder[^1] is ' ' or '\t') builder.Length--; }
        public override string ToString() => builder.ToString();
    }
    private sealed class Package
    {
        private readonly Dictionary<string, ZipArchiveEntry> entries = new(StringComparer.Ordinal); private long expanded;
        public CancellationToken Token { get; } public IEnumerable<string> Names => entries.Keys;
        public Package(ZipArchive archive, CancellationToken token)
        {
            Token = token; if (archive.Entries.Count > MaxEntries) throw new InvalidDataException("Office 压缩条目过多");
            long total = 0;
            foreach (var entry in archive.Entries)
            {
                token.ThrowIfCancellationRequested(); var name = entry.FullName;
                if (name.StartsWith('/') || name.Contains('\\') || name.Split('/').Any(x => x == "..") || name.Any(char.IsControl)) throw new InvalidDataException("Office 压缩路径无效");
                if (entry.Length > MaxEntryBytes || (total += entry.Length) > MaxExpandedBytes) throw new InvalidDataException("Office 解压体积超过上限");
                if (!entries.TryAdd(name, entry)) throw new InvalidDataException("Office 包含重复条目");
            }
        }
        public bool Contains(string part) => entries.ContainsKey(part);
        public void Check(XmlReader reader) { Token.ThrowIfCancellationRequested(); if (reader.Depth > 128) throw new InvalidDataException("Office XML 嵌套层级超过上限"); }
        public XmlReader Xml(string part)
        {
            if (!entries.TryGetValue(part, out var entry)) throw new InvalidDataException("Office 正文条目缺失: " + part);
            return XmlReader.Create(new Bounded(entry.Open(), this), new XmlReaderSettings { Async = true, CloseInput = true, DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = MaxEntryBytes, IgnoreComments = true, IgnoreProcessingInstructions = true });
        }
        private sealed class Bounded(Stream stream, Package package) : Stream
        {
            private long bytes;
            private void Count(int count) { package.Token.ThrowIfCancellationRequested(); bytes += count; package.expanded += count; if (bytes > MaxEntryBytes || package.expanded > MaxExpandedBytes) throw new InvalidDataException("Office 解压读取超过上限"); }
            public override int Read(byte[] buffer, int offset, int count) { var read = stream.Read(buffer, offset, count); Count(read); return read; }
            public override async Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) { var read = await stream.ReadAsync(buffer.AsMemory(offset, count), package.Token); Count(read); return read; }
            public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) { var read = await stream.ReadAsync(buffer, package.Token); Count(read); return read; }
            public override bool CanRead => true; public override bool CanSeek => false; public override bool CanWrite => false; public override long Length => throw new NotSupportedException(); public override long Position { get => bytes; set => throw new NotSupportedException(); }
            public override void Flush() { } public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException(); public override void SetLength(long value) => throw new NotSupportedException(); public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
            protected override void Dispose(bool disposing) { if (disposing) stream.Dispose(); base.Dispose(disposing); }
        }
    }
}
