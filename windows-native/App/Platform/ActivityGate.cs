namespace Buwei.Windows.Platform;

/// <summary>All unsaved editors, capture and transfers hold a lease until durably saved.</summary>
public sealed class ActivityGate
{
    private readonly object sync = new();
    private readonly Dictionary<Guid, string> activities = [];
    private bool restarting;
    public string[] Reasons { get { lock (sync) return [.. activities.Values]; } }
    public bool CanRestart => Reasons.Length == 0;
    public IDisposable Enter(string reason)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(reason);
        var id = Guid.NewGuid();
        lock (sync)
        {
            if (restarting) throw new InvalidOperationException("正在准备更新重启，请稍后操作。");
            activities.Add(id, reason);
        }
        return new Lease(() => { lock (sync) activities.Remove(id); });
    }
    public void RequireIdle()
    {
        var reasons = Reasons;
        if (reasons.Length != 0) throw new InvalidOperationException("请先保存或完成：" + string.Join("、", reasons));
    }
    public IDisposable BeginRestart()
    {
        lock (sync)
        {
            RequireIdle();
            if (restarting) throw new InvalidOperationException("更新已在进行。");
            restarting = true;
        }
        return new Lease(() => { lock (sync) restarting = false; });
    }
    private sealed class Lease(Action release) : IDisposable
    {
        private Action? action = release;
        public void Dispose() => Interlocked.Exchange(ref action, null)?.Invoke();
    }
}
