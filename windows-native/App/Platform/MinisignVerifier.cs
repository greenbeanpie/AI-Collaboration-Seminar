using System.Security.Cryptography;
using System.Text;

namespace Buwei.Windows.App.Platform;

public static class MinisignVerifier
{
    // Existing production public key. Never load or create a private signing key in the client.
    public const string ProductionKey = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEY2NTY2NTIwREE0RUE2MjkKUldRcHBrN2FJR1ZXOXVuRWU3WVZyWno3QkFBUzBEYThmODdsTkJ1YVhLMUlzSjYyWGIrbzIvaUIK";
    public static void Verify(ReadOnlySpan<byte> payload, string encodedSignature, string encodedKey = ProductionKey)
    {
        var keyLines = DecodeLines(encodedKey);
        var sigLines = DecodeLines(encodedSignature);
        if (keyLines.Length < 2 || sigLines.Length < 4 || !sigLines[2].StartsWith("trusted comment: ", StringComparison.Ordinal)) throw new CryptographicException("无效的 Minisign 文件。");
        var key = Convert.FromBase64String(keyLines[1]);
        var signature = Convert.FromBase64String(sigLines[1]);
        if (key.Length != 42 || signature.Length != 74 || key[0] != 'E' || key[1] != 'd' || signature[0] != 'E' || (signature[1] != 'd' && signature[1] != 'D')) throw new CryptographicException("不支持的 Minisign 算法。");
        if (!CryptographicOperations.FixedTimeEquals(key.AsSpan(2, 8), signature.AsSpan(2, 8))) throw new CryptographicException("更新签名密钥不匹配。");
        var message = payload.ToArray();
        if (signature[1] == 'D') message = Sodium.GenericHash.Hash(message, null, 64);
        var publicKey = key[10..]; var detached = signature[10..];
        if (!Sodium.PublicKeyAuth.VerifyDetached(detached, message, publicKey)) throw new CryptographicException("更新文件签名校验失败。");
        var comment = Encoding.UTF8.GetBytes(sigLines[2]["trusted comment: ".Length..]);
        var globalMessage = new byte[detached.Length + comment.Length];
        detached.CopyTo(globalMessage, 0); comment.CopyTo(globalMessage, detached.Length);
        var global = Convert.FromBase64String(sigLines[3]);
        if (global.Length != 64 || !Sodium.PublicKeyAuth.VerifyDetached(global, globalMessage, publicKey)) throw new CryptographicException("更新签名注释校验失败。");
    }
    private static string[] DecodeLines(string encoded) => Encoding.UTF8.GetString(Convert.FromBase64String(encoded.Trim())).Replace("\r", "", StringComparison.Ordinal).Split('\n', StringSplitOptions.RemoveEmptyEntries);
}
