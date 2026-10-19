using System.Text.Json.Nodes;

internal static class OfflineFixture
{
    public const string Root = "/api/v1/projects/11111111-1111-4111-8111-111111111111";
    public const string Source = "66666666-6666-4666-8666-666666666666";
    public const string Version = "77777777-7777-4777-8777-777777777777";
    public const string Index = Root + "/resource-index/source/" + Version;
    public const string Section = "第一节 / one";
    public static Dictionary<string, string> Query(Request request) => request.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries).Select(x => x.Split('=', 2)).ToDictionary(x => Uri.UnescapeDataString(x[0]), x => x.Length == 2 ? Uri.UnescapeDataString(x[1]) : "");
    public static JsonObject Data(Request request)
    {
        if (request.Method != "GET") throw new Exception("Offline preparation must never invoke a write or model endpoint.");
        if (request.Path == Index)
        {
            var second = Query(request).GetValueOrDefault("offset") == "20";
            var data = Metadata(); data["directoryOnly"] = true; data["indexStatus"] = "ready";
            data["items"] = new JsonArray(new JsonObject { ["sectionId"] = second ? "second" : Section, ["seq"] = second ? 1 : 0, ["heading"] = "目录", ["pageNumber"] = 1, ["startOffset"] = 0, ["endOffset"] = 6200 });
            data["nextOffset"] = second ? null : JsonValue.Create(20); return data;
        }
        if (request.Path == Index + "/section")
        {
            var query = Query(request); if (query.GetValueOrDefault("neighbors") != "true") throw new Exception("Native section neighbor context is required.");
            var first = query["sectionId"] == Section; var continuation = query.GetValueOrDefault("offset") == "6000";
            var data = Metadata(); data["sectionId"] = query["sectionId"]; data["offset"] = continuation ? 6000 : 0; data["nextOffset"] = first && !continuation ? JsonValue.Create(6000) : null;
            data["fragments"] = new JsonArray(new JsonObject { ["fragmentId"] = first ? "fragment-1" : "fragment-2", ["pageNumber"] = 1, ["quote"] = continuation ? "原文续读" : "已准备的原文" }); return data;
        }
        if (request.Path == Root + "/sources") return new JsonObject { ["items"] = new JsonArray(new JsonObject { ["sourceId"] = Source, ["currentVersionId"] = Version }), ["nextCursor"] = null };
        if (request.Path == Root + "/sources/" + Source) return new JsonObject { ["sourceId"] = Source, ["currentVersionId"] = Version };
        if (request.Path == Root + "/sources/" + Source + "/versions/" + Version) return new JsonObject { ["sourceVersionId"] = Version, ["revision"] = 1, ["status"] = "ready" };
        if (request.Path == Root) return new JsonObject { ["projectId"] = "11111111-1111-4111-8111-111111111111", ["name"] = "本机离线准备", ["revision"] = 1 };
        if (request.Path == Root + "/members/me") return new JsonObject { ["role"] = "owner" };
        if (request.Path == Root + "/goal") return new JsonObject { ["title"] = "准备原文", ["revision"] = 1 };
        if (new[] { "/api/v1/projects", Root + "/tasks/graph", Root + "/members", Root + "/tasks", Root + "/materials", Root + "/resource-library", Root + "/files" }.Contains(request.Path)) return new JsonObject { ["items"] = new JsonArray(), ["nextCursor"] = null };
        throw new Exception("Unexpected offline preparation endpoint: " + request.Path);
    }
    private static JsonObject Metadata() => new() { ["untrustedData"] = true, ["resourceType"] = "source", ["versionId"] = Version, ["resourceId"] = Source, ["revision"] = 1, ["coverage"] = "complete", ["title"] = "固定原文" };
}
