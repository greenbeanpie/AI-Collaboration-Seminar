using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.UI.Xaml;

namespace Buwei.Windows.Platform;

/// <summary>UI-thread desktop settings observer; no UWP event source or package identity required.</summary>
internal sealed class DesktopAppearance : IDisposable
{
    private readonly nint hwnd;
    private readonly SubclassProc procedure;
    private readonly Action changed;
    private bool disposed;

    public DesktopAppearance(Window window, Action changed)
    {
        hwnd = WinRT.Interop.WindowNative.GetWindowHandle(window);
        this.changed = changed;
        procedure = WindowProcedure;
        if (!SetWindowSubclass(hwnd, procedure, 85, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    public static bool HighContrast
    {
        get
        {
            var settings = new HighContrastInfo { Size = (uint)Marshal.SizeOf<HighContrastInfo>() };
            if (!SystemParametersInfo(0x0042, settings.Size, ref settings, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
            return (settings.Flags & 1) != 0;
        }
    }

    // COLORREF stores red in the low byte. Use the user's window/text pair in contrast mode.
    public static global::Windows.UI.Color SystemColor(bool foreground)
    {
        var value = GetSysColor(foreground ? 8 : 5);
        return Microsoft.UI.ColorHelper.FromArgb(255, (byte)value, (byte)(value >> 8), (byte)(value >> 16));
    }

    private nint WindowProcedure(nint window, uint message, nuint wParam, nint lParam, nuint id, nuint reference)
    {
        // Defer XAML work until Windows finishes processing the settings broadcast.
        if (!disposed && message is 0x0015 or 0x001A or 0x031A)
            Microsoft.UI.Dispatching.DispatcherQueue.GetForCurrentThread().TryEnqueue(() => { if (!disposed) changed(); });
        return DefSubclassProc(window, message, wParam, lParam);
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        RemoveWindowSubclass(hwnd, procedure, 85);
        GC.KeepAlive(procedure);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct HighContrastInfo { public uint Size, Flags; public nint DefaultScheme; }
    private delegate nint SubclassProc(nint hwnd, uint message, nuint wParam, nint lParam, nuint id, nuint reference);
    [DllImport("comctl32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetWindowSubclass(nint hwnd, SubclassProc proc, nuint id, nuint reference);
    [DllImport("comctl32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool RemoveWindowSubclass(nint hwnd, SubclassProc proc, nuint id);
    [DllImport("comctl32.dll")] private static extern nint DefSubclassProc(nint hwnd, uint message, nuint wParam, nint lParam);
    [DllImport("user32.dll", EntryPoint = "SystemParametersInfoW", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SystemParametersInfo(uint action, uint size, ref HighContrastInfo settings, uint flags);
    [DllImport("user32.dll")] private static extern uint GetSysColor(int index);
}
