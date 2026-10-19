using Microsoft.UI.Xaml;
using System.IO.Pipes;
using System.Text;

namespace Buwei.Windows;

public partial class App : Application
{
    private MainWindow? window;
    private Mutex? instance;
    public App() { InitializeComponent(); }
    protected override async void OnLaunched(LaunchActivatedEventArgs args)
    {
        var channel = Environment.GetCommandLineArgs().Contains("--benchmark") ? ".Benchmark" : "";
#if DEBUG
        if (Environment.GetEnvironmentVariable("BUWEI_WINDOWS_SMOKE") == "1") channel = ".Smoke";
#endif
        instance = new Mutex(true, "Local\\Buwei.Windows.Native." + Environment.UserName + channel, out var first);
        var arguments = string.Join(' ', Environment.GetCommandLineArgs().Skip(1));
        if (!first)
        {
            try
            {
                using var pipe = new NamedPipeClientStream(".", "Buwei.Windows.Native." + Environment.UserName + channel, PipeDirection.Out);
                await pipe.ConnectAsync(5000);
                using var writer = new StreamWriter(pipe, Encoding.UTF8) { AutoFlush = true };
                await writer.WriteLineAsync(arguments);
            }
            finally { Exit(); }
            return;
        }
        window = new MainWindow();
        window.Activate();
        await window.InitializeAsync(arguments);
        _ = ListenAsync(channel);
    }
    private async Task ListenAsync(string channel)
    {
        while (true)
        {
            try
            {
                await using var pipe = new NamedPipeServerStream("Buwei.Windows.Native." + Environment.UserName + channel, PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                await pipe.WaitForConnectionAsync();
                using var reader = new StreamReader(pipe, Encoding.UTF8);
                var command = await reader.ReadLineAsync();
                if (command is { Length: <= 8192 }) window?.DispatcherQueue.TryEnqueue(async () => await window.HandleActivationAsync(command));
            }
            catch (IOException) { }
        }
    }
}
