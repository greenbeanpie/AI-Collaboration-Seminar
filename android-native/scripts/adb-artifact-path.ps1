# Encode device identifiers before using them in Windows or Android artifact paths.
# Encoding underscores too keeps distinct serials from mapping to the same key.
function ConvertTo-AdbArtifactKey([string]$Device) {
    if ($Device -notmatch '^[A-Za-z0-9_.:-]+$') { throw 'Invalid device identifier' }
    return [regex]::Replace($Device, '[^A-Za-z0-9-]', [System.Text.RegularExpressions.MatchEvaluator]{
        param($match)
        '_' + ([int][char]$match.Value).ToString('x2') + '_'
    })
}
function Test-AdbArtifactKey {
    if ((ConvertTo-AdbArtifactKey 'localhost:5555') -cne 'localhost_3a_5555' -or
        (ConvertTo-AdbArtifactKey 'emulator-5556') -cne 'emulator-5556' -or
        (ConvertTo-AdbArtifactKey 'a:b') -ceq (ConvertTo-AdbArtifactKey 'a_3a_b')) {
        throw 'Device artifact key self-test failed'
    }
    try { ConvertTo-AdbArtifactKey '../bad/path' | Out-Null } catch { return }
    throw 'Invalid device identifier accepted'
}
