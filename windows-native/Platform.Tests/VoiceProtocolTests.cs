using Buwei.Windows.Platform;

var prefix = "/api/v1/projects/" + Guid.NewGuid() + "/rehearsals/" + Guid.NewGuid();
var id = Guid.NewGuid().ToString();
var expected = prefix + "/voice-sessions/" + id + "/stream";
if (NativeVoice.StreamPath(expected, prefix, id) != expected) throw new Exception("Voice path rejected.");
foreach (var bad in new[] { "https://evil.invalid" + expected, expected + "?token=secret", expected.Replace(id, Guid.NewGuid().ToString()), "//evil.invalid" + expected })
{
    try { NativeVoice.StreamPath(bad, prefix, id); throw new Exception("Unsafe voice path accepted."); }
    catch (InvalidDataException) { }
}
var samples = new float[] { -2, -1, -.5f, 0, .5f, 1, 2, float.NaN, float.PositiveInfinity };
var bytes = NativeVoice.FloatToPcm16(samples);
var expectedSamples = new short[] { -32768, -32768, -16384, 0, 16384, 32767, 32767, 0, 0 };
for (var index = 0; index < samples.Length; index++)
    if (System.Buffers.Binary.BinaryPrimitives.ReadInt16LittleEndian(bytes.AsSpan(index * 2, 2)) != expectedSamples[index]) throw new Exception("PCM16 conversion failed.");
if (NativeVoice.FloatToPcm16(new float[1600]).Length != 3200) throw new Exception("100ms PCM frame length is wrong.");
Console.WriteLine("PASS: fixed private WebSocket path, Float32→PCM16 clipping, non-finite input and 100ms frame size; no microphone/network/model calls.");
