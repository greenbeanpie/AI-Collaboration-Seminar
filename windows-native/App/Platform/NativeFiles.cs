using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Media.Imaging;
using Windows.Data.Pdf;
using Windows.Storage;
using Windows.Storage.Pickers;
using Windows.Storage.Streams;
using Windows.Graphics.Imaging;

namespace Buwei.Windows.Platform;

public sealed class NativeFiles(Window window)
{
    public async Task<StorageFile?> PickAsync(params string[] extensions)
    {
        var picker = new FileOpenPicker();
        foreach (var extension in extensions.Length == 0 ? ["*"] : extensions) picker.FileTypeFilter.Add(extension);
        WinRT.Interop.InitializeWithWindow.Initialize(picker, WinRT.Interop.WindowNative.GetWindowHandle(window));
        return await picker.PickSingleFileAsync();
    }
    public async Task<StorageFile?> SaveAsync(string name, string extension)
    {
        var picker = new FileSavePicker { SuggestedFileName = name };
        picker.FileTypeChoices.Add("文件", new List<string> { extension });
        WinRT.Interop.InitializeWithWindow.Initialize(picker, WinRT.Interop.WindowNative.GetWindowHandle(window));
        return await picker.PickSaveFileAsync();
    }
    public static async Task<BitmapImage> PreviewImageAsync(StorageFile file)
    {
        using var stream = await file.OpenReadAsync();
        var decoder = await BitmapDecoder.CreateAsync(stream);
        if (decoder.PixelWidth == 0 || decoder.PixelHeight == 0 || (ulong)decoder.PixelWidth * decoder.PixelHeight > 200_000_000)
            throw new InvalidDataException("图片尺寸超出安全预览范围，请另存原文件后打开。");
        var bitmap = new BitmapImage();
        if (decoder.PixelWidth >= decoder.PixelHeight) bitmap.DecodePixelWidth = 1600;
        else bitmap.DecodePixelHeight = 1600;
        stream.Seek(0);
        await bitmap.SetSourceAsync(stream);
        return bitmap;
    }
    public static async Task<(BitmapImage Image, uint Pages)> PreviewPdfAsync(StorageFile file, uint index = 0)
    {
        using var stream = await file.OpenReadAsync();
        var pdf = await PdfDocument.LoadFromStreamAsync(stream);
        if (index >= pdf.PageCount) throw new ArgumentOutOfRangeException(nameof(index));
        using var page = pdf.GetPage(index);
        using var rendered = new InMemoryRandomAccessStream();
        await page.RenderToStreamAsync(rendered, new PdfPageRenderOptions { DestinationWidth = 1400 });
        rendered.Seek(0);
        var bitmap = new BitmapImage();
        await bitmap.SetSourceAsync(rendered);
        return (bitmap, pdf.PageCount);
    }
    public static async Task<string> PreviewTextAsync(StorageFile file, CancellationToken ct = default)
    {
        await using var stream = File.OpenRead(file.Path);
        if (stream.Length > 2 * 1024 * 1024) throw new InvalidOperationException("文本预览上限为 2 MiB，请下载后打开。");
        using var reader = new StreamReader(stream, detectEncodingFromByteOrderMarks: true);
        return await reader.ReadToEndAsync(ct);
    }
}
