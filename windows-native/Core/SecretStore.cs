using System.Security.Cryptography;
using System.Text;

namespace Buwei.Windows.Core;

public sealed class SecretStore(string directory)
{
    public string DirectoryPath => directory;
    public void Write(string name, string? value)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("会话必须使用 Windows DPAPI");
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, ClientPaths.SafeSegment(name) + ".dat");
        if (value == null) { File.Delete(path); return; }
        var bytes = ProtectedData.Protect(Encoding.UTF8.GetBytes(value), null, DataProtectionScope.CurrentUser);
        var pending = path + ".pending"; File.WriteAllBytes(pending, bytes); File.Move(pending, path, true);
    }
    public string? Read(string name)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("会话必须使用 Windows DPAPI");
        var path = Path.Combine(directory, ClientPaths.SafeSegment(name) + ".dat");
        return File.Exists(path) ? Encoding.UTF8.GetString(ProtectedData.Unprotect(File.ReadAllBytes(path), null, DataProtectionScope.CurrentUser)) : null;
    }
}
