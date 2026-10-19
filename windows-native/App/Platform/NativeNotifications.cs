using System.Security;
using Microsoft.Windows.AppNotifications;

namespace Buwei.Windows.App.Platform;

public sealed class NativeNotifications : IDisposable
{
    private readonly AppNotificationManager manager = AppNotificationManager.Default;
    public event Action<string>? Activated;
    public NativeNotifications()
    {
        manager.NotificationInvoked += OnInvoked;
        manager.Register();
    }
    private void OnInvoked(AppNotificationManager sender, AppNotificationActivatedEventArgs args) => Activated?.Invoke(args.Argument);
    public void Show(string title, string body, string route)
    {
        if (!route.StartsWith('/') || route.StartsWith("//")) throw new ArgumentException("通知只能定位到应用内路径。", nameof(route));
        static string E(string value) => SecurityElement.Escape(value) ?? "";
        manager.Show(new AppNotification($"<toast launch=\"{E(route)}\"><visual><binding template=\"ToastGeneric\"><text>{E(title)}</text><text>{E(body)}</text></binding></visual></toast>"));
    }
    public void Dispose()
    {
        manager.NotificationInvoked -= OnInvoked;
        manager.Unregister();
    }
}
