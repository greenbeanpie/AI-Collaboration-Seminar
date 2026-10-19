# 发布许可收集

构建发布完成后运行 PowerShell 7：

```powershell
pwsh -NoProfile -File windows-native/scripts/collect-licenses.ps1 -PublishDirectory C:\path\to\publish
```

默认读取 App restore 后的 `obj/project.assets.json`；可用 `-AssetsFile` 指定其他 restore 输出。脚本不升级依赖，不联网，不复制 NuGet 二进制、SDK 或 Windows 字体，只收集选定 win-x64 依赖图中的 nuspec、LICENSE/COPYING/NOTICE 和来源元数据。发布目录实际存在的 runtime/native/resource 文件名匹配单独标记；其余条目标记为 restore/build-only-or-not-published，不以此宣称发布 WebView2 等构建依赖。

输出项目原始 GPLv3 `LICENSE`、`THIRD-PARTY-NOTICES.txt`、机器可读 JSON，以及 `licenses/<package>/<version>/`。包名、版本、源地址（移除凭据与查询参数）、NuGet SHA512、版权和许可声明均来自实际本机缓存，不推测许可。无本地许可全文的包使用脚本同目录固定上游快照，来源/版本/SHA256 记录于 `licenses/provenance.json`。PDFsharp 固定 6.2.4 MIT，不能替换为具有新许可要求的 6.5。SQLitePCLRaw 2.1.13 未公开对应上游 tag，采用该包 nuspec 声明的官方 Apache 2.0 全文，来源清楚标明，不伪造 tag。

自包含 .NET 运行库不属于普通 `assets.libraries`，脚本额外读取 restore 的 `downloadDependencies` 精确版本，并以发布目录 `coreclr.dll` 等文件确认实际发布。对 .NETCore/WindowsDesktop/AspNetCore 运行库包收集其 `LICENSE.TXT`、`THIRD-PARTY-NOTICES.TXT`、nuspec 与来源/hash，标记 `self-contained-framework-runtime-pack`；不把 Crossgen/引用包当作已发布运行库。若 restore 信息缺少 .NETCore 版本，仅使用实际 `coreclr.dll` 的 ProductVersion 回退，绝不选择缓存中的最高版本；识别失败明确列为缺失。

缺失缓存、nuspec、声明文件或完整许可会写入清单并警告；加 `-Strict` 使任何缺失阻止发布。无法取得完整许可时只能作为明确标记的本地预览产物，不应宣称已完成第三方许可发布检查。Windows SDK 构建工具可能仅有旧版许可 URL，须保留该限制；它的构建工具不会因收集脚本进入客户端。
