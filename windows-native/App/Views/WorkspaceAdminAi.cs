using System.Globalization;
using System.Text.Json.Nodes;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Buwei.Windows.Views;

public sealed partial class WorkspaceView
{
    private async Task<UIElement> AdminAiAsync(CancellationToken token)
    {
        if (repository.User.Text("role") != "super_admin") throw new InvalidOperationException("需要超级管理员权限。");
        var snapshot = await repository.GetAsync("/admin/ai-config", token); var config = snapshot?["config"];
        var panel = Page("AI 模型接入与语音配置", "仅保存你明确编辑的配置分区。未编辑密钥保持原值；新密钥不写入本机草稿。修改配置不会自动发起模型调用。");
        panel.Children.Add(Ui.Label("配置 v" + snapshot.Text("version") + " · " + (snapshot.Flag("enabled") ? "AI 已启用" : "AI 未启用"), 20));
        var routing = Ui.Choice("模型路由方式", [("advanced", "按用途分别配置"), ("unified", "统一模型")], config.Text("routingMode"));
        var search = new ToggleSwitch { Header = "允许联网搜索", IsOn = config.Flag("searchEnabled") };
        var routeDraft=await TrackFormAsync("admin-ai-routing",new(){["routingMode"]=routing,["searchEnabled"]=search},snapshot?["version"]);
        panel.Children.Add(Ui.Card(routing, search, Action("保存路由和联网搜索", async () => { var submitted=routeDraft.Snapshot();await WriteAsync("PUT", "/admin/ai-config", new JsonObject { ["expectedVersion"] = routeDraft.Identity.Copy(), ["routingMode"] = routing.Value(), ["searchEnabled"] = search.IsOn });await FinishFormAsync(routeDraft,submitted);draftDirty=false;saveCurrentDraft=null;await ReplaceAsync(AdminAiAsync); }, "保存路由和联网搜索配置？其他分区及凭据保持现状。")));
        foreach (var (key, label) in new[] { ("unified", "统一模型"), ("textEconomy", "文本与要求提取"), ("visionEconomy", "图片与 OCR"), ("review", "预审与答辩"), ("mediaUnderstanding", "Gemini 官方音视频理解"), ("mimoMediaUnderstanding", "小米官方音视频理解") })
            panel.Children.Add(Action(label, () => ReplaceAsync(ct => ModelConnectionAsync(snapshot, key, label, ct))));
        panel.Children.Add(Action("录音文件、演练与实时转写设置", () => ReplaceAsync(ct => AudioConfigurationAsync(snapshot, ct))));
        var enable = Action(snapshot.Flag("enabled") ? "停用 AI" : "启用已保存配置", async () =>
        {
            if (snapshot.Flag("enabled")) await WriteAsync("POST", "/admin/ai-config/disable", new JsonObject { ["expectedVersion"] = snapshot?["version"].Copy(), ["enabled"] = false });
            else await WriteAsync("PUT", "/admin/ai-config", new JsonObject { ["expectedVersion"] = snapshot?["version"].Copy(), ["enabled"] = true });
            await ReplaceAsync(AdminAiAsync);
        }, snapshot.Flag("enabled") ? "停用 AI？已保存模型配置及凭据保留。" : "启用已保存 AI 配置？后续业务请求可能产生模型费用。"); panel.Children.Add(enable);
        var purpose = Ui.Choice("模型测试用途", [("textEconomy", "文本与要求提取"), ("visionEconomy", "图片与 OCR"), ("review", "预审与答辩")]); var diagnostics = Ui.Stack();
        panel.Children.Add(Ui.Card(Ui.Label("连接与能力诊断", 20), purpose, Action("确认后测试模型（可能计费）", async () =>
        {
            var result = await WriteAsync("POST", "/admin/ai-config/probe", new JsonObject { ["purpose"] = purpose.Value() }); diagnostics.Children.Clear(); diagnostics.Children.Add(Ui.Label(result.Flag("passed") ? "测试通过" : "测试未通过"));
            foreach (var check in result.Rows("checks")) diagnostics.Children.Add(Ui.Label((check.Flag("passed") ? "通过 · " : "未通过 · ") + check.Text("name") + "：" + check.Text("detail")));
        }, "此测试会发起真实模型请求，可能产生费用。现在运行？"), diagnostics));
        return panel;
    }
    private async Task<UIElement> ModelConnectionAsync(JsonNode? snapshot, string purpose, string title, CancellationToken token)
    {
        var existing = snapshot?["config"]?[purpose];
        var panel = Page(title, "修改供应商地址时须重新填写或明确清除密钥；后端会拒绝将旧密钥转交给新地址。所有保存按配置版本核对。");
        var provider = Ui.Field("供应商标识", existing.Text("provider"), max: 100);
        var preset = Ui.Choice("供应商类型", [("custom", "自定义兼容接口"), ("openai", "OpenAI"), ("anthropic", "Anthropic Claude"), ("deepseek-anthropic", "DeepSeek Anthropic 兼容"), ("gemini", "Google Gemini"), ("deepseek", "DeepSeek"), ("openrouter", "OpenRouter"), ("opencode-zen", "OpenCode Zen"), ("opencode-go", "OpenCode Go")], existing.Text("providerPreset"));
        var protocol = Ui.Choice("接口协议", [("", "保留供应商默认协议"), ("chat-completions", "Chat Completions"), ("responses", "Responses"), ("messages", "Anthropic Messages"), ("gemini", "Gemini")], existing.Text("apiProtocol"));
        var model = Ui.Field("模型名称", existing.Text("model"), max: 200); var endpoint = Ui.Field("API 地址", existing.Text("apiUrl"), max: 2048);
        var timeout = Ui.Field("请求超时（毫秒，1000–600000）", existing.Text("timeoutMs") is { Length: > 0 } ms ? ms : "60000", max: 6); var input = Ui.Field("最大输入字符数", existing.Text("maxInputChars") is { Length: > 0 } chars ? chars : "100000", max: 9);
        var json = new CheckBox { Content = "支持 JSON 输出", IsChecked = existing.Flag("supportsJson") }; var vision = new CheckBox { Content = "支持图片输入", IsChecked = existing.Flag("supportsVision") };
        var reasoning = Ui.Choice("推理强度", [("", "不指定"), ("none", "关闭"), ("minimal", "最低"), ("low", "低"), ("medium", "中"), ("high", "高"), ("xhigh", "更高"), ("max", "最大")], existing.Text("reasoningEffort"));
        var temperature = Ui.Field("温度（0–2，留空不指定）", existing.Text("temperature"), max: 8); var topP = Ui.Field("Top P（0–1，留空不指定）", existing.Text("topP"), max: 8);
        var key = new PasswordBox { Header = existing.Flag("keyConfigured") ? "供应商密钥（已有配置，留空保留）" : "供应商密钥", MaxLength = 4096 };
        var clearKey = new CheckBox { Content = "明确清除已有供应商密钥" };
        key.PasswordChanged += (_, _) => sensitiveInput = key.Password.Length > 0;
        var go = new CheckBox { Content = "我已核对 OpenCode Go 套餐允许本应用用途", IsChecked = existing.Flag("goUsageAcknowledged") };
        var modelDraft=await TrackFormAsync("admin-ai-model:"+purpose,new(){["provider"]=provider,["providerPreset"]=preset,["apiProtocol"]=protocol,["model"]=model,["apiUrl"]=endpoint,["timeoutMs"]=timeout,["maxInputChars"]=input,["supportsJson"]=json,["supportsVision"]=vision,["reasoningEffort"]=reasoning,["temperature"]=temperature,["topP"]=topP,["clearKey"]=clearKey,["goUsageAcknowledged"]=go},snapshot);
        snapshot=modelDraft.Identity??snapshot;existing=snapshot?["config"]?[purpose];
        panel.Children.Add(Ui.Card(provider, preset, protocol, model, endpoint, key, clearKey, timeout, input, json, vision, reasoning, temperature, topP, go));
        panel.Children.Add(Action("保存此模型分区", async () =>
        {
            if (string.IsNullOrWhiteSpace(provider.Text) || string.IsNullOrWhiteSpace(model.Text)) throw new InvalidOperationException("请填写供应商标识和模型名称。");
            if (!int.TryParse(timeout.Text, out var duration) || duration < 1000 || duration > 600000 || !int.TryParse(input.Text, out var maximum) || maximum < 1) throw new InvalidOperationException("请填写有效超时及最大输入字符数。");
            if (endpoint.Text.Length > 0 && (!Uri.TryCreate(endpoint.Text, UriKind.Absolute, out var address) || address.Scheme != "https")) throw new InvalidOperationException("API 地址需要有效 HTTPS 地址，或留空使用供应商默认地址。");
            if (preset.Value() == "opencode-go" && go.IsChecked != true) throw new InvalidOperationException("请先确认 OpenCode Go 套餐用途。");
            var body = existing?.DeepClone() as JsonObject ?? new JsonObject(); body.Remove("keyConfigured"); body.Remove("apiKeyEncrypted");
            body["provider"] = provider.Text.Trim(); body["providerPreset"] = preset.Value(); body["model"] = model.Text.Trim(); body["apiUrl"] = endpoint.Text.Trim(); body["timeoutMs"] = duration; body["maxInputChars"] = maximum; body["supportsJson"] = json.IsChecked == true; body["supportsVision"] = vision.IsChecked == true;
            if (protocol.Value().Length > 0) body["apiProtocol"] = protocol.Value(); else body.Remove("apiProtocol");
            if (reasoning.Value().Length > 0) body["reasoningEffort"] = reasoning.Value(); else body.Remove("reasoningEffort");
            foreach (var (field, name, max) in new[] { (temperature, "temperature", 2d), (topP, "topP", 1d) })
            { if (field.Text.Length == 0) body.Remove(name); else { if (!double.TryParse(field.Text, NumberStyles.Float, CultureInfo.InvariantCulture, out var number) || !double.IsFinite(number) || number < 0 || number > max) throw new InvalidOperationException("温度或 Top P 数值无效。"); body[name] = number; } }
            if (key.Password.Length > 0 && clearKey.IsChecked == true) throw new InvalidOperationException("新密钥和清除密钥不能同时选择。");
            if (key.Password.Length > 0) body["apiKey"] = key.Password;
            if (clearKey.IsChecked == true) body["clearKey"] = true;
            body["goUsageAcknowledged"] = go.IsChecked == true;
            var submitted=modelDraft.Snapshot();await WriteAsync("PUT", "/admin/ai-config", new JsonObject { ["expectedVersion"] = snapshot?["version"].Copy(), [purpose] = body }); key.Password = ""; sensitiveInput = false;await FinishFormAsync(modelDraft,submitted);draftDirty=false;saveCurrentDraft=null;await ReplaceAsync(AdminAiAsync);
        }, "仅保存此模型分区？其他配置及未编辑密钥由后端保留。此操作不会发起模型请求。", true));
        if (purpose is "mediaUnderstanding" or "mimoMediaUnderstanding") panel.Children.Add(Action("明确移除此可选分区", async () => { await WriteAsync("PUT", "/admin/ai-config", new JsonObject { ["expectedVersion"] = snapshot?["version"].Copy(), [purpose == "mediaUnderstanding" ? "clearMediaUnderstanding" : "clearMimoMediaUnderstanding"] = true }); key.Password = ""; sensitiveInput = false; await ReplaceAsync(AdminAiAsync); }, "移除此媒体理解配置？现有历史记录仍保留。"));
        return panel;
    }
    private async Task<UIElement> AudioConfigurationAsync(JsonNode? snapshot, CancellationToken token)
    {
        var config = snapshot?["config"]; var strategies = config?["processingStrategies"]; var speech = config?["rehearsalSpeech"]; var realtime = config?["realtimeAudioTranscription"];
        var panel = Page("录音文件、演练与实时转写", "文件转写、演练语音播放和 Gateway 实时转写分别配置。");
        var audio = Ui.Choice("录音文件处理", [("whisper-first", "Whisper 优先，必要时官方媒体理解"), ("media-only", "Gemini 官方音频理解"), ("mimo-only", "小米官方音频理解")], strategies.Text("audioFiles"));
        var video = Ui.Choice("视频文件处理", [("gemini", "Gemini"), ("mimo", "小米")], strategies.Text("videoFiles")); var rehearsal = Ui.Choice("答辩演练方式", [("text", "文字演练"), ("voice-with-text-fallback", "语音演练，文字回退")], strategies.Text("rehearsal"));
        var language = Ui.Field("本机语音语言", speech.Text("lang") is { Length: > 0 } lang ? lang : "zh-CN", max: 64); var rate = Ui.Field("朗读速度（0.5–2）", speech.Text("rate") is { Length: > 0 } speed ? speed : "1", max: 8); var volume = Ui.Field("朗读音量（0–1）", speech.Text("volume") is { Length: > 0 } loud ? loud : "1", max: 8);
        var audioDraft=await TrackFormAsync("admin-audio-strategies",new(){["audioFiles"]=audio,["videoFiles"]=video,["rehearsal"]=rehearsal,["language"]=language,["rate"]=rate,["volume"]=volume},snapshot?["version"]);
        panel.Children.Add(Ui.Card(audio, video, rehearsal, language, rate, volume, Ui.Label("文件转写固定使用 Workers AI · @cf/openai/whisper-large-v3-turbo"), Action("保存文件与演练语音策略", async () =>
        {
            if (!double.TryParse(rate.Text, out var speed) || !double.IsFinite(speed) || speed < .5 || speed > 2 || !double.TryParse(volume.Text, out var loud) || !double.IsFinite(loud) || loud < 0 || loud > 1) throw new InvalidOperationException("请填写有效朗读速度及音量。");
            var submitted=audioDraft.Snapshot();await WriteAsync("PUT", "/admin/ai-config", new JsonObject { ["expectedVersion"] = audioDraft.Identity.Copy(), ["processingStrategies"] = new JsonObject { ["audioFiles"] = audio.Value(), ["videoFiles"] = video.Value(), ["rehearsal"] = rehearsal.Value() }, ["rehearsalSpeech"] = new JsonObject { ["provider"] = "system-local", ["lang"] = language.Text.Trim(), ["rate"] = speed, ["volume"] = loud }, ["audioFileTranscription"] = new JsonObject { ["provider"] = "workers-ai", ["model"] = "@cf/openai/whisper-large-v3-turbo" } });await FinishFormAsync(audioDraft,submitted);draftDirty=false;saveCurrentDraft=null;await ReplaceAsync(AdminAiAsync);
        }, "保存处理策略？只影响后续操作，历史处理结果不变。")));
        var gateway = Ui.Field("Cloudflare Gateway ID", realtime.Text("gatewayId"), max: 64); var languages = Ui.Field("语言代码（逗号分隔，最多 8 个）", string.Join(",", realtime.Rows("languageCodes")), max: 512); var credential = new PasswordBox { Header = realtime.Flag("gatewayTokenConfigured") ? "Gateway 认证令牌（已配置，留空保留）" : "Gateway 认证令牌", MaxLength = 4096 }; var clear = new CheckBox { Content = "明确清除 Gateway 认证令牌" };
        credential.PasswordChanged += (_, _) => sensitiveInput = credential.Password.Length > 0;
        var realtimeDraft=await TrackFormAsync("admin-realtime-transcription",new(){["gatewayId"]=gateway,["languageCodes"]=languages,["clearGatewayToken"]=clear},snapshot?["version"]);
        panel.Children.Add(Ui.Card(Ui.Label("Gateway 实时音频转写", 20), Ui.Label("固定 Google AI Studio · gemini-3.5-transcribe-live"), gateway, languages, credential, clear, Action("保存实时转写", async () =>
        {
            if (credential.Password.Length > 0 && clear.IsChecked == true) throw new InvalidOperationException("新令牌与清除令牌不能同时选择。");
            var codes = languages.Text.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries); if (codes.Length > 8) throw new InvalidOperationException("最多填写 8 个语言代码。");
            var body = new JsonObject { ["provider"] = "google-ai-studio", ["model"] = "gemini-3.5-transcribe-live", ["gatewayId"] = gateway.Text.Trim(), ["languageCodes"] = new JsonArray(codes.Select(x => (JsonNode?)JsonValue.Create(x)).ToArray()) };
            if (credential.Password.Length > 0) body["gatewayToken"] = credential.Password; if (clear.IsChecked == true) body["clearGatewayToken"] = true;
            var submitted=realtimeDraft.Snapshot();await WriteAsync("PUT", "/admin/ai-config", new JsonObject { ["expectedVersion"] = realtimeDraft.Identity.Copy(), ["realtimeAudioTranscription"] = body }); credential.Password = ""; sensitiveInput = false;await FinishFormAsync(realtimeDraft,submitted);draftDirty=false;saveCurrentDraft=null;await ReplaceAsync(AdminAiAsync);
        }, "保存 Gateway 实时转写配置？其他方式的模型配置保持现状。")));
        return panel;
    }
}
