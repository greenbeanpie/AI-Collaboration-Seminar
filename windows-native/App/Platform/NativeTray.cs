using System.Runtime.InteropServices;
using Microsoft.UI.Xaml;

namespace Buwei.Windows.App.Platform;

/// <summary>Owned by the UI thread. Closing to tray is a shell policy, not done by this class.</summary>
public sealed class NativeTray : IDisposable
{
    private const uint CallbackMessage = 0x8000 + 84;
    private readonly nint hwnd;
    private readonly SubclassProc procedure;
    private readonly uint taskbarCreated;
    private NotifyIconData data;
    private bool disposed;
    public event Action? ShowRequested;
    public event Action? ExitRequested;
    public NativeTray(Window window)
    {
        hwnd = WinRT.Interop.WindowNative.GetWindowHandle(window);
        procedure = WindowProcedure;
        taskbarCreated = RegisterWindowMessage("TaskbarCreated");
        data = new NotifyIconData { Size = (uint)Marshal.SizeOf<NotifyIconData>(), Window = hwnd, Id = 1, Flags = 1 | 2 | 4, Callback = CallbackMessage, Icon = LoadIcon(0, (nint)32512), Tip = "补位 · Windows 原生客户端", Info = "", Title = "" };
        if (!SetWindowSubclass(hwnd, procedure, 84, 0)) throw new System.ComponentModel.Win32Exception();
        if (!Shell_NotifyIcon(0, ref data)) { RemoveWindowSubclass(hwnd, procedure, 84); throw new System.ComponentModel.Win32Exception(); }
    }
    public void HideWindow() => ShowWindow(hwnd, 0);
    public void ShowWindow()
    { ShowWindow(hwnd, 9); SetForegroundWindow(hwnd); ShowRequested?.Invoke(); }
    private nint WindowProcedure(nint window, uint message, nuint wParam, nint lParam, nuint id, nuint reference)
    {
        if (message == taskbarCreated) Shell_NotifyIcon(0, ref data);
        if (message == CallbackMessage)
        {
            var mouse = (uint)((long)lParam & 0xffff);
            if (mouse is 0x0203 or 0x0202) ShowWindow();
            if (mouse == 0x0205)
            {
                var menu = CreatePopupMenu();
                try
                {
                    AppendMenu(menu, 0, 1, "打开补位"); AppendMenu(menu, 0, 2, "退出");
                    GetCursorPos(out var point); SetForegroundWindow(hwnd);
                    var command = TrackPopupMenu(menu, 0x100 | 0x2, point.X, point.Y, 0, hwnd, 0);
                    if (command == 1) ShowWindow(); if (command == 2) ExitRequested?.Invoke();
                }
                finally { DestroyMenu(menu); }
            }
        }
        return DefSubclassProc(window, message, wParam, lParam);
    }
    public void Dispose()
    {
        if (disposed) return; disposed = true;
        Shell_NotifyIcon(2, ref data); RemoveWindowSubclass(hwnd, procedure, 84);
        GC.KeepAlive(procedure);
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct NotifyIconData
    {
        public uint Size; public nint Window; public uint Id, Flags, Callback; public nint Icon;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Tip;
        public uint State, StateMask;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string Info;
        public uint Timeout;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string Title;
        public uint InfoFlags; public Guid Guid; public nint BalloonIcon;
    }
    [StructLayout(LayoutKind.Sequential)] private struct Point { public int X, Y; }
    private delegate nint SubclassProc(nint hwnd, uint message, nuint wParam, nint lParam, nuint id, nuint reference);
    [DllImport("comctl32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetWindowSubclass(nint hwnd, SubclassProc proc, nuint id, nuint reference);
    [DllImport("comctl32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool RemoveWindowSubclass(nint hwnd, SubclassProc proc, nuint id);
    [DllImport("comctl32.dll")] private static extern nint DefSubclassProc(nint hwnd, uint msg, nuint wParam, nint lParam);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool Shell_NotifyIcon(uint operation, ref NotifyIconData data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern nint LoadIcon(nint instance, nint name);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool ShowWindow(nint hwnd, int command);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetForegroundWindow(nint hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern uint RegisterWindowMessage(string message);
    [DllImport("user32.dll")] private static extern nint CreatePopupMenu();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool AppendMenu(nint menu, uint flags, nuint id, string text);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] private static extern uint TrackPopupMenu(nint menu, uint flags, int x, int y, int reserved, nint hwnd, nint rect);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool DestroyMenu(nint menu);
}
