using System.Text.Json.Nodes;
namespace Buwei.Windows.Core;
public static class TaskProposalParent
{
    // Preserve omission unless the effective parent has actually been changed.
    // Returning a fresh row keeps failed requests from modifying the preview baseline.
    public static JsonObject Apply(JsonObject original, string field, string initialParent, string selectedParent)
    {
        var result = (JsonObject)original.DeepClone();
        if (selectedParent != initialParent) result[field] = selectedParent.Length == 0 ? null : JsonValue.Create(selectedParent);
        return result;
    }
}
