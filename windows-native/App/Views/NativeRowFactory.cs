using System.Text.Json.Nodes;
using Microsoft.UI.Xaml;

namespace Buwei.Windows.Views;

/// <summary>Creates native cards only for the visible range of a bounded, virtualized list.</summary>
internal sealed class NativeRowFactory(Func<JsonNode, UIElement> render) : IElementFactory
{
    public UIElement GetElement(ElementFactoryGetArgs args) => render((JsonNode)args.Data);
    public void RecycleElement(ElementFactoryRecycleArgs args) { }
}
