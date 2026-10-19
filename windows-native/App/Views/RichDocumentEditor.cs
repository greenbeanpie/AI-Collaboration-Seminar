using System.Text.Json.Nodes;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Buwei.Windows.Views;

/// <summary>Edits the persisted document tree directly. Unsupported nodes and attributes survive unchanged.</summary>
public sealed class RichDocumentEditor : UserControl
{
    private JsonObject document;
    private readonly Stack<string> undo = new();
    private readonly Stack<string> redo = new();
    private readonly StackPanel blocks = Ui.Stack();
    private readonly TextBlock notice = Ui.Label("");
    private TextBox? selectedField;
    private JsonObject? selectedText;
    private bool readOnly;
    public JsonObject Document => (JsonObject)document.DeepClone();
    public event Action<JsonObject>? Changed;
    public RichDocumentEditor(JsonNode? initial, bool readOnly = false)
    {
        this.readOnly = readOnly;
        document = initial?.DeepClone() as JsonObject ?? Node("doc", Node("paragraph", TextNode("")));
        var root = Ui.Stack();
        if (!readOnly)
        {
            var tools = new VariableSizedWrapGrid { Orientation = Orientation.Horizontal, MaximumRowsOrColumns = 6, ItemHeight = 42, ItemWidth = 100 };
            Add("撤销", () => { if (undo.TryPop(out var previous)) { redo.Push(document.ToJsonString()); document = JsonNode.Parse(previous)!.AsObject(); Refresh(); Changed?.Invoke(Document); } });
            Add("重做", () => { if (redo.TryPop(out var next)) { undo.Push(document.ToJsonString()); document = JsonNode.Parse(next)!.AsObject(); Refresh(); Changed?.Invoke(Document); } });
            foreach (var mark in new[] { ("bold", "粗体"), ("italic", "斜体"), ("strike", "删除线"), ("code", "行内代码") }) Add(mark.Item2, () => Format(mark.Item1));
            root.Children.Add(tools);
            root.Children.Add(Ui.Label("选中文字后设置格式；段落、列表、表格及引用按结构保存。无法识别的附加内容保持原样。", 12));
            var insert = Ui.Choice("插入内容", [("paragraph", "正文段落"), ("heading", "标题"), ("bulletList", "无序列表"), ("orderedList", "有序列表"), ("blockquote", "引用块"), ("codeBlock", "代码块"), ("table", "3 × 3 表格"), ("horizontalRule", "分隔线")]);
            root.Children.Add(insert); root.Children.Add(Ui.Button("插入", () => { Change(() => Children(document).Add(CreateBlock(insert.Value()))); return Task.CompletedTask; }));
            void Add(string title, Action action) { tools.Children.Add(Ui.Button(title, () => { action(); return Task.CompletedTask; })); }
        }
        root.Children.Add(notice); root.Children.Add(blocks); Content = root; Refresh();
    }
    private static JsonObject Node(string type, params JsonNode[] content) => new() { ["type"] = type, ["content"] = new JsonArray(content) };
    private static JsonObject TextNode(string value) => new() { ["type"] = "text", ["text"] = value };
    private static JsonArray Children(JsonObject node) { if (node["content"] is not JsonArray result) node["content"] = result = new JsonArray(); return result; }
    private static JsonObject CreateBlock(string type) => type switch
    {
        "table" => Node("table", Enumerable.Range(0, 3).Select(_ => (JsonNode)Node("tableRow", Enumerable.Range(0, 3).Select(_ => (JsonNode)Node("tableCell", Node("paragraph", TextNode("")))).ToArray())).ToArray()),
        "bulletList" or "orderedList" => Node(type, Node("listItem", Node("paragraph", TextNode("")))),
        "blockquote" => Node(type, Node("paragraph", TextNode(""))),
        "horizontalRule" => new JsonObject { ["type"] = type },
        "heading" => new JsonObject { ["type"] = type, ["attrs"] = new JsonObject { ["level"] = 2 }, ["content"] = new JsonArray(TextNode("")) },
        _ => Node(type, TextNode(""))
    };
    private void Change(Action action, bool refresh = true)
    {
        if (readOnly) return;
        undo.Push(document.ToJsonString()); if (undo.Count > 40) { var keep = undo.Take(40).Reverse().ToArray(); undo.Clear(); foreach (var item in keep) undo.Push(item); }
        redo.Clear(); action(); if (refresh) Refresh(); Changed?.Invoke(Document);
    }
    private void Refresh()
    { selectedField = null; selectedText = null; blocks.Children.Clear(); Render(document, blocks, 0); }
    private void Format(string mark)
    {
        if (selectedField == null || selectedText == null || selectedField.SelectionLength == 0) { notice.Text = "请先选中需要设置格式的文字。"; return; }
        var target = selectedText; var start = selectedField.SelectionStart; var length = selectedField.SelectionLength;
        if (target.Parent is not JsonArray parent) return;
        var index = parent.IndexOf(target); var text = target.Text("text");
        Change(() =>
        {
            var middle = (JsonObject)target.DeepClone(); middle["text"] = text.Substring(start, length);
            var marks = middle["marks"] as JsonArray ?? new JsonArray();
            var existing = marks.FirstOrDefault(x => x.Text("type") == mark);
            if (existing != null) marks.Remove(existing); else marks.Add(new JsonObject { ["type"] = mark });
            middle["marks"] = marks;
            parent.RemoveAt(index); var offset = 0;
            if (start > 0) { var before = target.DeepClone().AsObject(); before["text"] = text[..start]; parent.Insert(index + offset++, before); }
            parent.Insert(index + offset++, middle);
            if (start + length < text.Length) { var after = target.DeepClone().AsObject(); after["text"] = text[(start + length)..]; parent.Insert(index + offset, after); }
        });
        notice.Text = "文字格式已更新，保存新版本后生效。";
    }
    private void Render(JsonObject node, StackPanel parent, int depth)
    {
        if (depth > 30) { parent.Children.Add(Ui.Label("嵌套内容已保留，当前仅显示至第 30 层。")); return; }
        var type = node.Text("type");
        if (type == "text")
        {
            if (readOnly) { var label = Ui.Label(node.Text("text")); foreach (var mark in node.Rows("marks")) { if (mark.Text("type") == "bold") label.FontWeight = Microsoft.UI.Text.FontWeights.Bold; if (mark.Text("type") == "italic") label.FontStyle = global::Windows.UI.Text.FontStyle.Italic; } parent.Children.Add(label); return; }
            var field = Ui.Field("文字" + string.Join("", node.Rows("marks").Select(m => " · " + m.Text("type"))), node.Text("text"), true, 200000);
            field.MinHeight = 42; field.GotFocus += (_, _) => { selectedField = field; selectedText = node; };
            field.SelectionChanged += (_, _) => { selectedField = field; selectedText = node; };
            field.TextChanged += (_, _) => { if (field.Text != node.Text("text")) Change(() => node["text"] = field.Text, false); };
            parent.Children.Add(field); return;
        }
        if (type is "hardBreak" or "horizontalRule") { parent.Children.Add(new Border { Height = type == "hardBreak" ? 8 : 1, Background = (Microsoft.UI.Xaml.Media.Brush)Application.Current.Resources["DividerStrokeColorDefaultBrush"] }); return; }
        var names = new Dictionary<string, string> { ["doc"] = "正文", ["paragraph"] = "段落", ["heading"] = "标题", ["bulletList"] = "无序列表", ["orderedList"] = "有序列表", ["listItem"] = "列表项", ["table"] = "表格", ["tableRow"] = "表格行", ["tableCell"] = "单元格", ["tableHeader"] = "表头", ["blockquote"] = "引用", ["codeBlock"] = "代码块" };
        if (!names.ContainsKey(type)) { parent.Children.Add(Ui.Card(Ui.Label(type == "citation" ? "已保留原文引用" : "已保留附加内容"), Ui.Label(node["attrs"].Id("label", "title", "text")))); return; }
        var container = Ui.Stack(); if (type != "doc") container.Children.Add(Ui.Label(names[type], type == "heading" ? 20 : 12));
        if (!readOnly && type is "paragraph" or "heading" or "codeBlock")
        {
            var style = Ui.Choice("段落样式", [("paragraph", "正文"), ("heading", "标题"), ("codeBlock", "代码块")], type);
            style.SelectionChanged += (_, _) => { if (style.Value() != node.Text("type")) Change(() => { node["type"] = style.Value(); if (style.Value() == "heading") node["attrs"] = new JsonObject { ["level"] = 2 }; }); };
            container.Children.Add(style);
        }
        var children = Children(node);
        foreach (var child in children.OfType<JsonObject>().ToArray())
        {
            Render(child, container, depth + 1);
            if (!readOnly && child.Text("type") != "text" && type != "tableRow")
            {
                var tools = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6 };
                tools.Children.Add(Ui.Button("上移", () => { var index = children.IndexOf(child); if (index > 0) Change(() => { children.Remove(child); children.Insert(index - 1, child); }); return Task.CompletedTask; }));
                tools.Children.Add(Ui.Button("下移", () => { var index = children.IndexOf(child); if (index < children.Count - 1) Change(() => { children.Remove(child); children.Insert(index + 1, child); }); return Task.CompletedTask; }));
                tools.Children.Add(Ui.Button("删除块", async () => { var dialog = new ContentDialog { Title = "删除此内容块？", Content = "保存前可以撤销。", PrimaryButtonText = "删除", CloseButtonText = "保留", XamlRoot = XamlRoot }; if (await dialog.ShowAsync() == ContentDialogResult.Primary) Change(() => children.Remove(child)); }));
                container.Children.Add(tools);
            }
        }
        if (!readOnly)
        {
            if (type is "paragraph" or "heading" or "codeBlock" && children.Count == 0) container.Children.Add(Ui.Button("添加文字", () => { Change(() => children.Add(TextNode(""))); return Task.CompletedTask; }));
            if (type is "bulletList" or "orderedList") container.Children.Add(Ui.Button("添加列表项", () => { Change(() => children.Add(Node("listItem", Node("paragraph", TextNode(""))))); return Task.CompletedTask; }));
            if (type is "listItem" or "tableCell" or "tableHeader" or "blockquote") container.Children.Add(Ui.Button("添加段落", () => { Change(() => children.Add(Node("paragraph", TextNode("")))); return Task.CompletedTask; }));
            if (type == "table")
            {
                container.Children.Add(Ui.Button("添加行", () => { Change(() => { var columns = children.FirstOrDefault()?["content"]?.AsArray().Count ?? 1; children.Add(Node("tableRow", Enumerable.Range(0, columns).Select(_ => (JsonNode)Node("tableCell", Node("paragraph", TextNode("")))).ToArray())); }); return Task.CompletedTask; }));
                container.Children.Add(Ui.Button("添加列", () => { Change(() => { foreach (var row in children.OfType<JsonObject>()) Children(row).Add(Node("tableCell", Node("paragraph", TextNode("")))); }); return Task.CompletedTask; }));
            }
        }
        if (type == "doc") parent.Children.Add(container); else parent.Children.Add(Ui.Card(container));
    }
}
