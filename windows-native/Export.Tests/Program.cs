using System.Text;
using System.Text.Json.Nodes;
using Buwei.Windows.Core;
using PdfSharp.Pdf.IO;

if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("Installed Windows CJK font required");
var root = Path.Combine(Path.GetTempPath(), "Buwei-Export-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
var bundle = JsonNode.Parse("""
{
 "project":{"id":"project-original","name":"中文项目成果报告","description":"保留完整历史与原文引用。","competition_deadline_date":"2026-11-30","status":"active"},
 "generatedAt":"2026-10-19T12:00:00Z",
 "mainGoal":{"projectId":"project-original","title":"实现研究目标","detail":"目标详情","revision":3,"graphRevision":4},
 "standardsVersions":[{"standardsVersionId":"standard-fixed","version":2,"title":"固定标准","requirements":[{"requirementId":"requirement-one","detail":"要求正文"}],"rubric":{"rubricVersionId":"rubric-fixed","weights":[{"key":"quality","label":"质量","weight":70}]}}],
 "requirementSets":[{"requirementSetId":"set-original","sourceVersionId":"source-version-fixed","sourceAvailability":"unavailable","requirements":[{"requirementId":"requirement-one","title":"提交研究报告","citations":[{"sourceVersionId":"source-version-fixed","fragmentId":"fragment-fixed","pageNumber":7,"quote":"原文引句不得改变","availability":"unavailable","deletedAt":"2026-10-01"}]}]}],
 "rubricVersions":[{"rubricId":"rubric-fixed","version":2,"weights":[{"key":"quality","label":"质量","weight":70}]}],
 "tasks":[{"taskId":"task-one","title":"研究任务","detail":"任务正文","criteria":"验收要求","dependsOnTaskIds":["task-prior"],"currentSubmissionId":"submission-fixed","status":"submitted","assignee_id":"member-one","due_date":"2026-11-01","citations":[{"sourceVersionId":"source-version-fixed","fragmentId":"fragment-fixed","pageNumber":7,"quote":"原文引句不得改变"}]}],
 "taskDependencies":[{"taskId":"task-one","dependsOnTaskId":"task-prior"}],
 "taskLinks":[{"linkId":"link-one","taskId":"task-one","kind":"material","targetId":"material-original"}],
 "taskSubmissions":[{"submissionId":"submission-fixed","taskId":"task-one","round":2,"submittedBy":"member-one","body":"提交正文","materialVersionIds":["material-version-fixed"],"humanScoreOverride":{"quality":88},"decision":"accept","feedback":"人工反馈"}],
 "sources":[{"sourceId":"source-original","title":"原始来源","purpose":"reference","currentVersionId":"source-version-fixed","deletedAt":null}],
 "sourceVersions":[{"sourceVersionId":"source-version-fixed","sourceId":"source-original","revision":1,"fragments":[{"fragmentId":"fragment-fixed","pageNumber":7,"seq":1,"content":"原始片段正文"}]}],
 "materials":[{"materialId":"material-original","versionId":"material-version-fixed","title":"研究成果","markdown":"## 研究结论\n包含中文与 Markdown 内容。","attachments":[{"fileId":"file-original","name":"附件.xlsx","availability":"unavailable"}]}],
 "materialVersions":[{"versionId":"material-version-old","materialId":"material-original","revision":1,"markdown":"历史正文","attachments":[]}],
 "assessments":[{"assessmentId":"assessment-fixed","kind":"material_review","standardsVersionId":"standard-fixed","materialVersionIds":["material-version-fixed"],"report":{"summary":"分析结论","citations":[{"fragmentId":"fragment-fixed"}]},"historical":false}],
 "legacyReviews":[{"reviewId":"legacy-fixed","requirementSetId":"set-original","report":{"summary":"历史评审"}}],
 "rehearsalTurns":[{"rehearsalId":"rehearsal-original","sequence":1,"kind":"answer","content":{"text":"演练回答"}}],
 "events":[{"type":"task.submitted","occurred_at":"2026-10-18T12:00:00Z"}],
 "aiUsage":{"calls":12,"promptTokens":1234,"completionTokens":456},
 "futureField":{"original":"future-value-preserved"}
}
""")!;
var tests = new List<(string, Func<Task>)>();
tests.Add(("Markdown retains identifiers references all sections and input JSON", () =>
{
    var original = bundle.ToJsonString(); var markdown = ProjectExport.Markdown(bundle);
    foreach (var token in new[] { "中文项目成果报告", "task-one", "task-prior", "material-version-fixed", "material-version-old", "source-version-fixed", "fragment-fixed", "原文引句不得改变", "unavailable", "附件.xlsx", "assessment-fixed", "standard-fixed", "rubric-fixed", "legacy-fixed", "rehearsal-original", "future-value-preserved", "AI 用量", "输入令牌数：1234" }) True(markdown.Contains(token), token);
    True(original == bundle.ToJsonString(), "input mutated"); return Task.CompletedTask;
}));
tests.Add(("missing fonts refuse explicitly without touching existing file", () =>
{
    var existing = Path.Combine(root, "font-existing.pdf"); File.WriteAllText(existing, "original");
    try { _ = new ProjectExport.InstalledChineseFontResolver(root); throw new Exception("missing font accepted"); } catch (FileNotFoundException) { }
    True(File.ReadAllText(existing) == "original", "existing lost"); return Task.CompletedTask;
}));
tests.Add(("restricted font embedding flags are rejected", () =>
{
    var directory = Path.Combine(root, "restricted-font"); Directory.CreateDirectory(directory);
    var font = new byte[40]; font[5] = 1; Encoding.ASCII.GetBytes("OS/2").CopyTo(font, 12); font[23] = 28; font[27] = 12;
    foreach (var flags in new ushort[] { 2, 0x100, 0x200 })
    {
        font[36] = (byte)(flags >> 8); font[37] = (byte)flags; File.WriteAllBytes(Path.Combine(directory, "simhei.ttf"), font);
        try { _ = new ProjectExport.InstalledChineseFontResolver(directory); throw new Exception("restricted font accepted"); } catch (InvalidDataException) { }
    }
    return Task.CompletedTask;
}));
tests.Add(("multipage Chinese PDF has real content and preserves bundle", async () =>
{
    var longBundle = bundle.DeepClone(); longBundle["project"]!["description"] = string.Join('\n', Enumerable.Range(1, 200).Select(i => $"第{i}项研究：中文分页验证，资源消耗与任务依赖都应清晰展示。原文引用 fragment-fixed，材料 material-version-fixed。"));
    var before = longBundle.ToJsonString(); var target = Environment.GetEnvironmentVariable("BUWEI_EXPORT_TEST_ARTIFACT") ?? Path.Combine(root, "multipage.pdf");
    await ProjectExport.PdfAsync(longBundle, target);
    using var pdf = PdfReader.Open(target, PdfDocumentOpenMode.Import); True(pdf.PageCount >= 2, "not multipage");
    for (var i = 0; i < pdf.PageCount; i++) True(pdf.Pages[i].Contents.CreateSingleContent().Stream.UnfilteredValue.Length > 20, "empty PDF page");
    True(File.ReadAllBytes(target).AsSpan(0, 5).SequenceEqual(Encoding.ASCII.GetBytes("%PDF-")), "not PDF");
    True(before == longBundle.ToJsonString(), "bundle mutated"); True(!File.Exists(target + ".partial"), "partial retained");
    Console.WriteLine($"PDF artifact: {target}; pages={pdf.PageCount}; bytes={new FileInfo(target).Length}");
}));
tests.Add(("existing destination is preserved", async () =>
{
    var path = Path.Combine(root, "existing.pdf"); await File.WriteAllTextAsync(path, "original"); await Reject(() => ProjectExport.PdfAsync(bundle, path));
    True(await File.ReadAllTextAsync(path) == "original", "existing overwritten"); True(!File.Exists(path + ".partial"), "unexpected partial");
}));
tests.Add(("preexisting partial is preserved and final never appears", async () =>
{
    var path = Path.Combine(root, "pending.pdf"); await File.WriteAllTextAsync(path + ".partial", "someone else");
    await Reject(() => ProjectExport.PdfAsync(bundle, path)); True(!File.Exists(path), "unexpected final"); True(await File.ReadAllTextAsync(path + ".partial") == "someone else", "partial overwritten/deleted");
}));
tests.Add(("cancellation leaves no final or partial", async () =>
{
    var path = Path.Combine(root, "canceled.pdf"); using var cancel = new CancellationTokenSource(); cancel.Cancel();
    await Reject(() => ProjectExport.PdfAsync(bundle, path, cancel.Token)); True(!File.Exists(path) && !File.Exists(path + ".partial"), "canceled output exists");
}));
tests.Add(("bad schema fails without writing a file", async () =>
{
    var path = Path.Combine(root, "bad.pdf"); await Reject(() => ProjectExport.PdfAsync(new JsonObject(), path)); True(!File.Exists(path), "bad output exists");
}));
var failed = 0;
try { foreach (var (name, run) in tests) { try { await run(); Console.WriteLine("PASS " + name); } catch (Exception ex) { failed++; Console.Error.WriteLine("FAIL " + name + "\n" + ex); } } }
finally { Directory.Delete(root, true); }
Console.WriteLine($"{tests.Count - failed}/{tests.Count} project export tests passed"); return failed == 0 ? 0 : 1;
static void True(bool condition, string reason) { if (!condition) throw new Exception(reason); }
static async Task Reject(Func<Task> run) { try { await run(); } catch (Exception ex) when (ex is IOException or OperationCanceledException or InvalidDataException) { return; } throw new Exception("Expected export rejection"); }
