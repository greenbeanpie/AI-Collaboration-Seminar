using CommunityToolkit.Mvvm.ComponentModel;

namespace Buwei.Windows.ViewModels;

public sealed partial class MainWindowViewModel : ObservableObject
{
    [ObservableProperty] public partial string Status { get; set; } = "正在恢复账户";
    [ObservableProperty] public partial string AccountName { get; set; } = "";
    [ObservableProperty] public partial bool Authenticated { get; set; }
}
