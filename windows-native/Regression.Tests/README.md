# Native Core regression harness

Run on Windows with the pinned .NET SDK:

```powershell
dotnet run --project windows-native/Regression.Tests/Buwei.Windows.Regression.Tests.csproj -c Release
```

Uses synthetic accounts, a fake HTTP handler and temporary SQLite/DPAPI files. Does not call production, paid models or real accounts. Outputs individual scenario results and exits nonzero on failure. Covers actual logout contract, PKCE hostile callbacks/replay, offline wrapper/idempotency lost-response retry, concurrent write ownership, revocation, conflict/blocked writes and cross-account reads. This is Core regression evidence, not UI, installation, real server or microphone acceptance.
