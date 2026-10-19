using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Buwei.Windows.Core;

namespace Buwei.Windows.Platform;

/// <summary>Imports modern Office body text through the existing version-bound document protocol, without model calls.</summary>
public static class NativeDocumentImport
{
    public static async Task ImportOfficeAsync(ClientRepository repo, string projectId, string fileId, string path, CancellationToken ct = default)
    {
        if (!Guid.TryParse(projectId, out _) || !Guid.TryParse(fileId, out _)) throw new ArgumentException("项目或文件标识无效。");
        if (!OfficeTextReader.IsSupported(path)) throw new NotSupportedException("仅支持 DOCX、XLSX 和 PPTX 本机正文导入。");
        var owner = repo.AccountId ?? throw new InvalidOperationException("请先登录。");
        var sessionUser = repo.User;
        void Guard()
        {
            ct.ThrowIfCancellationRequested();
            if (owner != repo.AccountId || !ReferenceEquals(sessionUser, repo.User)) throw new InvalidOperationException("账户会话已变化，本机导入已停止。");
        }
        var root = "/projects/" + Uri.EscapeDataString(projectId);
        var key = "office-import:" + projectId + ":" + fileId;
        var saved = await repo.Store.LoadDraftAsync(key); Guard();
        var hash = await HashAsync(path, ct); Guard();
        if (saved?["sha256"]?.ToString() is { Length: > 0 } previousHash && previousHash != hash)
            throw new InvalidOperationException("本机待导入文件已变化。已有正文批次和原文件保留；请重新选择原文件，或以新文件版本导入。");
        JsonNode? source = null; string? cursor = null; var cursors = new HashSet<string>();
        do
        {
            Guard();
            var page = await repo.GetAsync(root + "/sources?limit=100" + (cursor == null ? "" : "&cursor=" + Uri.EscapeDataString(cursor)), ct); Guard();
            source = (page?["items"] as JsonArray)?.FirstOrDefault(x => x?["fileId"]?.ToString() == fileId);
            if (source != null) break;
            cursor = page?["nextCursor"]?.ToString();
            if (!string.IsNullOrEmpty(cursor) && !cursors.Add(cursor)) throw new InvalidOperationException("来源分页没有前进，请刷新后重试。");
        } while (!string.IsNullOrEmpty(cursor));
        if (source == null)
        {
            Guard();
            var title = Path.GetFileName(path); if (title.Length > 200) title = title[..200];
            source = await repo.SendAsync("POST", root + "/sources", new JsonObject { ["kind"] = "file", ["title"] = title, ["fileId"] = fileId, ["purpose"] = "reference" }, ct: ct); Guard();
        }
        if (source == null) throw new InvalidDataException("文件来源登记未返回身份，原文件保留。");
        var sourceId = source["sourceId"]?.ToString() ?? throw new InvalidDataException("来源缺少身份。");
        var version = source["currentVersionId"]?.ToString() ?? throw new InvalidDataException("来源缺少固定版本。");
        var lifecycle = source["lifecycleVersion"]?.ToString() ?? throw new InvalidDataException("来源缺少生命周期版本。");
        async Task GuardSourceAsync(CancellationToken token)
        {
            Guard(); var current = await repo.GetAsync(root + "/sources/" + Uri.EscapeDataString(sourceId), token); Guard();
            if (current?["currentVersionId"]?.ToString() != version || current?["lifecycleVersion"]?.ToString() != lifecycle || !string.IsNullOrEmpty(current?["deletedAt"]?.ToString()) || current?["fileId"]?.ToString() != fileId)
                throw new InvalidOperationException("来源版本、原文件或生命周期已变化，请刷新核对后继续。");
        }
        // Parse before opening a server session: a malformed archive must not leave a claimed import behind.
        var text = await Task.Run(() => OfficeTextReader.ReadAsync(path, ct), ct); Guard();
        if (hash != await HashAsync(path, ct)) throw new InvalidOperationException("正文提取期间本机文件发生变化，导入已停止，原文件保留。");
        await GuardSourceAsync(ct);
        var extension = Path.GetExtension(path).ToLowerInvariant()[1..];
        var init = await repo.SendAsync("POST", root + "/document-imports", new JsonObject { ["sourceVersionId"] = version, ["method"] = "browser-" + extension }, ct: ct); Guard();
        var sessionId = init?["sessionId"]?.ToString() ?? throw new InvalidDataException("正文导入会话缺少身份。");
        var endpoint = root + "/document-imports/" + Uri.EscapeDataString(sessionId);
        var sameInput = saved?["sha256"]?.ToString() == hash && saved?["sourceVersionId"]?.ToString() == version && saved?["sessionId"]?.ToString() == sessionId && saved?["lifecycleVersion"]?.ToString() == lifecycle;
        await repo.Store.SaveDraftAsync(key, new JsonObject { ["sha256"] = hash, ["sourceVersionId"] = version, ["sessionId"] = sessionId, ["lifecycleVersion"] = lifecycle }); Guard();
        try
        {
            var status = await repo.GetAsync(endpoint, ct); Guard();
            if (status?["textReady"]?.ToString() == "true" || status?["status"]?.ToString() == "complete") { await repo.Store.DeleteDraftAsync(key); return; }
            var accepted = int.TryParse(status?["nextBatch"]?.ToString(), out var nextBatch) ? nextBatch : throw new InvalidDataException("正文导入进度缺少批次位置。");
            var batch = 0; var offset = 0;
            while (offset < text.Length)
            {
                Guard(); var length = Math.Min(16000, text.Length - offset);
                if (offset + length < text.Length && char.IsHighSurrogate(text[offset + length - 1]) && char.IsLowSurrogate(text[offset + length])) length--;
                var content = text.Substring(offset, length); offset += length;
                // A recovered session without a matching local fingerprint replays accepted batches: the backend validates their digest.
                if (!sameInput || batch >= accepted)
                {
                    await GuardSourceAsync(ct);
                    await repo.SendAsync("POST", endpoint + "/batches", new JsonObject { ["batchNumber"] = batch, ["blocks"] = new JsonArray(new JsonObject { ["seq"] = batch, ["pageNumber"] = null, ["text"] = content, ["headingPath"] = new JsonArray() }) }, ct: ct); Guard();
                }
                batch++;
            }
            if (accepted > batch) throw new InvalidDataException("服务端已接收正文多于当前本机文件，请核对原文件后继续。");
            await GuardSourceAsync(ct);
            var result = await repo.SendAsync("POST", endpoint + "/complete", new JsonObject { ["totalPages"] = null, ["warnings"] = new JsonArray(), ["partial"] = false, ["interrupted"] = false }, ct: ct); Guard();
            if (result?["textReady"]?.ToString() != "true") throw new InvalidDataException("未提取到完整可读正文，原文件及已接收批次保留。");
            await repo.Store.DeleteDraftAsync(key);
        }
        catch
        {
            // Do not redirect cleanup into a new account or retry the original request. Partial completion only labels accepted text.
            if (owner == repo.AccountId && ReferenceEquals(sessionUser, repo.User))
            {
                using var cleanup = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                try { await repo.SendAsync("POST", endpoint + "/complete", new JsonObject { ["totalPages"] = null, ["warnings"] = new JsonArray("本机 Office 导入中断，原文件和已接收正文批次保留"), ["partial"] = true, ["interrupted"] = true }, ct: cleanup.Token); }
                catch (Exception) { /* Best-effort partial label must not replace the original import error. */ }
            }
            throw;
        }
    }
    private static async Task<string> HashAsync(string path, CancellationToken ct)
    {
        await using var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 65536, FileOptions.Asynchronous | FileOptions.SequentialScan);
        if (input.Length > OfficeTextReader.MaxArchiveBytes) throw new InvalidDataException("Office 文件超过 64 MiB 本机提取上限。");
        return Convert.ToHexString(await SHA256.HashDataAsync(input, ct));
    }
}
