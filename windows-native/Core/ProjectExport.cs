using System.Globalization;
using System.Buffers.Binary;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using PdfSharp.Drawing;
using PdfSharp.Fonts;
using PdfSharp.Pdf;

namespace Buwei.Windows.Core;

/// <summary>Semantic exports of the existing ledger export-bundle; never mutates the bundle.</summary>
public static class ProjectExport
{
    private static readonly object PdfGate = new();
    private static InstalledChineseFontResolver? resolver;
    private const int MaxCharacters = 8_000_000;
    private static readonly (string Key, string Title)[] Sections = [
        ("mainGoal", "项目目标"), ("standardsVersions", "标准版本"), ("requirementSets", "要求集与固定原文引用"),
        ("rubricVersions", "评分维度版本"), ("tasks", "任务"), ("taskDependencies", "任务依赖"), ("taskLinks", "任务关联"),
        ("taskSubmissions", "任务提交与审阅"), ("materials", "当前成果材料"), ("materialVersions", "成果材料历史版本"),
        ("sources", "原始资料"), ("sourceVersions", "原始资料版本与片段"), ("assessments", "评估记录"),
        ("legacyReviews", "历史评审"), ("rehearsalTurns", "演练轮次"), ("events", "活动历史"), ("aiUsage", "AI 用量")];
    private static readonly Dictionary<string, string> Labels = new(StringComparer.Ordinal) {
        ["id"]="项目 ID", ["name"]="名称", ["description"]="项目说明", ["competition_deadline_date"]="比赛截止日期", ["status"]="状态",
        ["projectId"]="项目 ID", ["title"]="标题", ["detail"]="详情", ["revision"]="修订号", ["graphRevision"]="任务图修订号", ["version"]="版本", ["createdAt"]="创建时间", ["occurred_at"]="发生时间",
        ["taskId"]="任务 ID", ["dependsOnTaskId"]="依赖任务 ID", ["dependsOnTaskIds"]="依赖任务 ID", ["criteria"]="验收标准", ["effortHours"]="预计工时", ["lifecycleState"]="生命周期", ["currentSubmissionId"]="当前提交 ID", ["assignee_id"]="负责人 ID", ["due_date"]="截止日期",
        ["submissionId"]="提交 ID", ["round"]="轮次", ["submittedBy"]="提交人 ID", ["body"]="提交正文", ["decision"]="审阅决定", ["feedback"]="反馈", ["aiReport"]="AI 报告", ["humanScoreOverride"]="人工分数修订",
        ["materialId"]="成果材料 ID", ["versionId"]="材料版本 ID", ["materialVersionIds"]="固定材料版本 ID", ["markdown"]="材料正文", ["attachments"]="附件", ["fileId"]="文件 ID", ["availability"]="可用性", ["deletedAt"]="删除时间", ["purpose"]="用途",
        ["sourceId"]="来源 ID", ["currentVersionId"]="当前版本 ID", ["sourceVersionId"]="来源版本 ID", ["fragments"]="原文片段", ["fragmentId"]="片段 ID", ["pageNumber"]="页码", ["seq"]="序号", ["content"]="正文", ["quote"]="原文引句", ["citations"]="固定原文引用", ["origin"]="来源类型",
        ["requirementSetId"]="要求集 ID", ["requirementId"]="要求 ID", ["requirements"]="要求", ["category"]="分类", ["dueDate"]="截止日期", ["duePrecision"]="日期精度", ["fieldState"]="字段确认状态", ["confirmedAt"]="确认时间", ["sourceAvailability"]="来源可用性", ["sourceDeletedAt"]="来源删除时间",
        ["standardsVersionId"]="标准版本 ID", ["standardsVersion"]="标准版本号", ["requirementSetIds"]="要求集 ID", ["rubricVersionId"]="评分版本 ID", ["rubricId"]="评分表 ID", ["weights"]="维度权重", ["key"]="维度键", ["label"]="维度名称", ["weight"]="权重", ["notes"]="说明", ["mappings"]="要求与维度映射", ["dimensionKey"]="维度键", ["active"]="当前生效",
        ["assessmentId"]="评估 ID", ["kind"]="类型", ["goalRevision"]="目标修订号", ["goal"]="固定目标快照", ["report"]="评估报告", ["historical"]="历史记录", ["reviewId"]="评审 ID", ["rehearsalId"]="演练 ID", ["sequence"]="轮次序号", ["jobId"]="后台任务 ID", ["jobError"]="后台任务错误", ["linkId"]="关联 ID", ["targetId"]="关联目标 ID", ["type"]="事件类型",
        ["calls"]="调用次数", ["promptTokens"]="输入令牌数", ["completionTokens"]="输出令牌数"
    };
    public static string Markdown(JsonNode bundle)
    {
        if (bundle is not JsonObject data || data["project"] is not JsonObject project) throw new InvalidDataException("导出汇总缺少项目数据");
        var text = new StringBuilder();
        void Line(string value = "") { if (text.Length + value.Length + Environment.NewLine.Length > MaxCharacters) throw new InvalidDataException("导出文本超过 800 万字符上限"); text.AppendLine(value); }
        void Value(JsonNode? node, int depth)
        {
            if (depth > 32) throw new InvalidDataException("导出数据嵌套过深");
            var indent = new string(' ', Math.Min(depth, 12) * 2);
            if (node is JsonObject obj)
            {
                foreach (var (key, value) in obj)
                {
                    var label = Labels.GetValueOrDefault(key, key);
                    if (value is JsonObject || value is JsonArray)
                    { Line(indent + "- " + label + "："); Value(value, depth + 1); }
                    else
                    {
                        var scalar = Scalar(value);
                        if (scalar.Contains('\n')) { Line(indent + "- " + label + "："); foreach (var line in scalar.Replace("\r\n", "\n").Split('\n')) Line(indent + "  " + line); }
                        else Line(indent + "- " + label + "：" + scalar);
                    }
                }
            }
            else if (node is JsonArray array)
            {
                if (array.Count == 0) Line(indent + "（无记录）");
                for (var i = 0; i < array.Count; i++)
                {
                    if (array[i] is JsonObject || array[i] is JsonArray) { Line(indent + $"- 记录 {i + 1}"); Value(array[i], depth + 1); }
                    else Line(indent + "- " + Scalar(array[i]));
                }
            }
            else Line(indent + Scalar(node));
        }
        Line("# " + Scalar(project["name"])); Line(); Line("导出时间：" + Scalar(data["generatedAt"]));
        Line("此文档包含固定版本、标识与引用；附件仅列出引用信息，原始 JSON 汇总可用于完整数据核对。");
        Line(); Line("## 项目概况"); Value(project, 0);
        foreach (var (key, title) in Sections) { if (!data.ContainsKey(key)) continue; Line(); Line("## " + title); Value(data[key], 0); }
        var known = Sections.Select(s => s.Key).Append("project").Append("generatedAt").ToHashSet(StringComparer.Ordinal);
        foreach (var (key, value) in data.Where(x => !known.Contains(x.Key))) { Line(); Line("## " + key); Value(value, 0); }
        return text.ToString();
    }
    private static string Scalar(JsonNode? value) => value == null ? "（未设置）" : value is JsonValue scalar && scalar.GetValueKind() == JsonValueKind.String ? scalar.GetValue<string>() : value.ToJsonString();

    public static Task PdfAsync(JsonNode bundle, string path, CancellationToken ct = default)
    {
        // Capture immutable content before leaving the UI thread.
        var markdown = Markdown(bundle);
        return Task.Run(() =>
        {
            ct.ThrowIfCancellationRequested(); var destination = Path.GetFullPath(path); var pending = destination + ".partial"; var ownPending = false;
            if (File.Exists(destination)) throw new IOException("目标文件已存在，请选择新文件名");
            lock (PdfGate)
            {
                ct.ThrowIfCancellationRequested();
                resolver ??= new InstalledChineseFontResolver();
                if (GlobalFontSettings.FontResolver == null) GlobalFontSettings.FontResolver = resolver;
                else if (!ReferenceEquals(GlobalFontSettings.FontResolver, resolver)) throw new InvalidOperationException("PDF 字体解析器已由其他组件初始化");
                using var document = new PdfDocument(); document.Info.Title = "补位 · 项目成果导出"; document.Info.Creator = "Buwei Windows Native";
                var options = new XPdfFontOptions(PdfFontEncoding.Unicode);
                var body = new XFont(InstalledChineseFontResolver.Family, 10.5, XFontStyleEx.Regular, options);
                var heading = new XFont(InstalledChineseFontResolver.Family, 15, XFontStyleEx.Regular, options);
                var title = new XFont(InstalledChineseFontResolver.Family, 20, XFontStyleEx.Regular, options);
                var footer = new XFont(InstalledChineseFontResolver.Family, 8, XFontStyleEx.Regular, options);
                XGraphics? graphics = null; PdfPage? page = null; double y = 0;
                const double margin = 46; const double top = 48; const double bottom = 55;
                void Page()
                {
                    graphics?.Dispose(); if (document.PageCount >= 1000) throw new InvalidDataException("PDF 页数超过 1000 页上限");
                    page = document.AddPage(); page.Size = PdfSharp.PageSize.A4; graphics = XGraphics.FromPdfPage(page); y = top;
                }
                try
                {
                    Page();
                    foreach (var source in markdown.Replace("\r\n", "\n").Split('\n'))
                    {
                        ct.ThrowIfCancellationRequested();
                        var font = source.StartsWith("# ", StringComparison.Ordinal) ? title : source.StartsWith("## ", StringComparison.Ordinal) ? heading : body;
                        var line = ReferenceEquals(font, title) ? source[2..] : ReferenceEquals(font, heading) ? source[3..] : source;
                        var lineHeight = font.Size * 1.55;
                        if (font != body) { if (y + lineHeight * 2 > page!.Height.Point - bottom) Page(); y += 7; }
                        if (line.Length == 0) { y += 6; continue; }
                        var width = page!.Width.Point - margin * 2;
                        foreach (var wrapped in Wrap(line.Replace("\t", "    "), graphics!, font, width, ct).ToArray())
                        {
                            if (y + lineHeight > page.Height.Point - bottom) Page();
                            graphics!.DrawString(wrapped, font, XBrushes.Black, new XRect(margin, y, width, lineHeight), XStringFormats.TopLeft); y += lineHeight;
                        }
                        if (font != body) y += 4;
                    }
                    graphics?.Dispose(); graphics = null;
                    for (var i = 0; i < document.PageCount; i++)
                    {
                        ct.ThrowIfCancellationRequested(); var p = document.Pages[i]; using var g = XGraphics.FromPdfPage(p, XGraphicsPdfPageOptions.Append);
                        g.DrawLine(new XPen(XColors.LightGray, .5), margin, p.Height.Point - 38, p.Width.Point - margin, p.Height.Point - 38);
                        g.DrawString($"补位 · 项目导出    {i + 1} / {document.PageCount}", footer, XBrushes.Gray, new XRect(margin, p.Height.Point - 30, p.Width.Point - margin * 2, 15), XStringFormats.TopCenter);
                    }
                    ct.ThrowIfCancellationRequested();
                    using (var stream = new FileStream(pending, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { ownPending = true; document.Save(stream, false); stream.Flush(true); }
                    ct.ThrowIfCancellationRequested(); File.Move(pending, destination, false); ownPending = false;
                }
                finally { graphics?.Dispose(); if (ownPending) File.Delete(pending); }
            }
        }, ct);
    }
    private static IEnumerable<string> Wrap(string value, XGraphics graphics, XFont font, double width, CancellationToken ct)
    {
        IEnumerable<string> Tokens()
        {
            var text = StringInfo.GetTextElementEnumerator(value); var word = new StringBuilder();
            while (text.MoveNext())
            {
                ct.ThrowIfCancellationRequested(); var element = text.GetTextElement();
                if (element.Length == 1 && (char.IsAsciiLetterOrDigit(element[0]) || "-_/.:?&=%#@+~".Contains(element[0]))) { word.Append(element); continue; }
                if (word.Length > 0) { yield return word.ToString(); word.Clear(); }
                yield return element;
            }
            if (word.Length > 0) yield return word.ToString();
        }
        var line = new StringBuilder(); var measured = 0d;
        foreach (var token in Tokens())
        {
            var advance = graphics.MeasureString(token, font).Width;
            // Keep identifiers/words together whenever they fit a whole line.
            if (advance <= width)
            {
                if (line.Length != 0 && measured + advance > width) { yield return line.ToString(); line.Clear(); measured = 0; }
                line.Append(token); measured += advance; continue;
            }
            var graphemes = StringInfo.GetTextElementEnumerator(token);
            while (graphemes.MoveNext())
            {
                ct.ThrowIfCancellationRequested(); var element = graphemes.GetTextElement(); advance = graphics.MeasureString(element, font).Width;
                if (advance > width) throw new InvalidDataException("字符宽度超出 PDF 页面");
                if (line.Length != 0 && measured + advance > width) { yield return line.ToString(); line.Clear(); measured = 0; }
                line.Append(element); measured += advance;
            }
        }
        if (line.Length != 0) yield return line.ToString();
    }

    /// <summary>Loads only an installed Windows font. No font files ship with this application.</summary>
    public sealed class InstalledChineseFontResolver : IFontResolver
    {
        public const string Family = "BuweiInstalledChinese";
        private readonly byte[] font;
        public InstalledChineseFontResolver(string? fontDirectory = null)
        {
            var directory = fontDirectory ?? Environment.GetFolderPath(Environment.SpecialFolder.Fonts);
            var path = new[] { "simhei.ttf", "Deng.ttf" }.Select(name => Path.Combine(directory, name)).FirstOrDefault(File.Exists)
                ?? throw new FileNotFoundException("未找到 Windows 中文字体 simhei.ttf 或 Deng.ttf，无法生成中文 PDF");
            font = File.ReadAllBytes(path);
            // OS/2 fsType: permit installable/preview-print/editable embedding only.
            // Reject restricted, bitmap-only and no-subsetting fonts rather than ignoring their flags.
            if (font.Length < 12) throw new InvalidDataException("中文字体文件无效");
            var tables = BinaryPrimitives.ReadUInt16BigEndian(font.AsSpan(4, 2)); var found = false;
            for (var i = 0; i < tables; i++)
            {
                var start = 12 + i * 16; if (start + 16 > font.Length) throw new InvalidDataException("字体目录无效");
                if (!font.AsSpan(start, 4).SequenceEqual("OS/2"u8)) continue;
                var offset = BinaryPrimitives.ReadUInt32BigEndian(font.AsSpan(start + 8, 4)); var length = BinaryPrimitives.ReadUInt32BigEndian(font.AsSpan(start + 12, 4));
                if (length < 10 || (long)offset + length > font.Length) throw new InvalidDataException("字体许可表无效");
                var flags = BinaryPrimitives.ReadUInt16BigEndian(font.AsSpan((int)offset + 8, 2));
                if ((flags & 0x0302) != 0) throw new InvalidDataException("安装字体不允许此 PDF 的子集嵌入");
                found = true; break;
            }
            if (!found) throw new InvalidDataException("字体缺少嵌入许可表，不能导出 PDF");
        }
        public FontResolverInfo? ResolveTypeface(string familyName, bool bold, bool italic) => familyName == Family ? new FontResolverInfo(Family) : null;
        public byte[] GetFont(string faceName) => faceName == Family ? font : throw new InvalidOperationException("未授权字体");
    }
}
