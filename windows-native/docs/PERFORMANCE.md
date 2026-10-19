# Windows 原生客户端资源对比

2026-10-20，同机完成 12 轮匿名启动/托盘采样。**WinUI 前台的私有字节和工作集相加均较低；托盘私有字节较低，但工作集相加高于已挂起的旧版。不能据此宣称所有内存指标均下降。**

## 结果

下表为“每轮采样中位数，再取三轮中位数”；括号为三轮中位数的最小至最大值。MiB = 1,048,576 字节。

| 场景 | 客户端 | 私有字节树总和 MiB | 工作集相加 MiB | CPU 机器归一化中位数 |
| --- | --- | ---: | ---: | ---: |
| 匿名前台 | WinUI | 82.18（82.05–82.66） | 150.53（150.40–151.11） | 0.00% |
| 匿名前台 | Tauri | 555.26（530.57–563.44） | 885.72（872.18–916.75） | 0.00% |
| 匿名托盘 | WinUI | 74.94（74.81–76.69） | 142.57（142.36–145.23） | 0.00% |
| 匿名托盘 | Tauri | 208.42（196.90–217.90） | 62.07（61.49–63.50） | 0.00% |

相对于旧版，WinUI 前台私有字节中位数下降 **85.20%**，工作集相加下降 **83.01%**；托盘私有字节下降 **64.04%**，但工作集相加**增加 129.69%**。这些是本次固定场景的观察值，不是所有业务场景的降幅承诺。两者空闲 CPU 中位数均为零，本次没有证据证明空闲 CPU 改善。

**私有字节是进程提交的私有虚拟内存，不等于物理 RAM 或 VRAM。工作集是驻留页；多进程工作集相加会重复计算共享页，也不等于应用独占物理内存。两种指标不得相加或互相替代。**

前台 `WaitForInputIdle` 三轮中位数：WinUI 144.06 ms，Tauri 91.91 ms。该计时只表示根进程输入循环达到空闲，不包含旧版 WebView 后续页面的视觉/可用就绪；系统文件缓存未清除，因此不作为视觉启动速度或严格冷启动结论。托盘启动不记录该计时。

## 方法与样本完整性

- 环境：Intel Core Ultra 9 275HX，24 逻辑处理器，Windows NT 10.0.26100。采样于新加坡时间 2026-10-20 00:11 开始。
- 两者均为 x64 Release，使用相同生产服务来源，保持匿名。新版使用 `--benchmark` 独立数据目录/单实例通道，关闭更新轮询；旧版使用下述独立应用标识。未登录账号、调用模型、清除用户会话或操作真实业务数据。
- 每轮预热 30 秒，随后运行约 60 秒轮询窗口；每场景三轮。轮询之间等待 1,000 ms，系统查询开销另计，因此不是严格 1 Hz。CPU 使用实际采样间隔及 24 个逻辑处理器归一化。
- 记录启动根进程及递归观察到的子进程，保存 PID、父 PID 和创建时间；未把所有同名 WebView 进程都归入旧版。短于轮询间隔的进程可能被漏采，系统共享服务也不因名称相似而计入。
- 顺序为 WinUI 前台、WinUI 托盘、Tauri 前台、Tauri 托盘。**其他独立任务的后台负载未受控制，本次不是严格隔离实验。** 默认窗口尺寸亦不同：源码中 WinUI 为 1440×960、Tauri 为 1120×780，未通过 GUI 统一尺寸。
- 用户停止了 GUI 自动化后，本阶段仅使用 CLI 启动、进程计数器、源码与日志读取；没有截图、点击或其他 GUI 自动化。未完成登录页视觉/交互就绪验收。

| 轮次 | WinUI 前台有效点 | WinUI 托盘有效点 | Tauri 前台有效点 | Tauri 托盘有效点 |
| --- | ---: | ---: | ---: | ---: |
| 1 | 35 | 35 | 35 | 36 |
| 2 | 34 | 32 | 32 | 34 |
| 3 | 35 | 36 | 33 | 29 |
| 合计 | 104 | 103 | 100 | 99 |

Python 标准库独立审计通过：共 **406 条聚合采样、1,700 条进程采样**。每轮样本编号连续、时间单调；每个观察到的进程都能沿已记录父链返回该轮唯一启动根进程；每点进程数量、私有字节及工作集之和精确对应聚合 CSV。12 轮及 4 组汇总的中位数均从原始 CSV 重算，与导出的 JSON 一致；首末采样时间、每轮峰值和 CPU 均值保留在审计文件中。

观察到的进程：WinUI 始终只有 `Buwei.Windows.Native.exe`；Tauri 前台为 `buwei-desktop.exe` 加 7 个 `msedgewebview2.exe`，托盘为根进程加 6 个 WebView 子进程，未混入其他进程名。该结论限定于本次匿名场景。

旧版隔离配置的诊断日志记录了三次 `webview suspension: status=Ok(()); accepted=true`。源码显式调用 `SetIsVisible(false)` 和 `TrySuspend`，未发现显式 `EmptyWorkingSet`/`SetProcessWorkingSetSize`。日志只证明这些挂起请求获接受，不证明完整原生握手、登录界面或认证状态已验收；也不能据此断言 WebView 内部具体如何修剪驻留页。实测驻留指标以上表及 CSV 为准。

## 构建与交付证据

原生发布源代码冻结记录为 `8225036c`。最终发布物在采样前、后均核对哈希；完整值见 [final-artifacts.json](../../output/windows-native/resources/final-artifacts.json)。

| 发布文件 | SHA-256 |
| --- | --- |
| Buwei.Windows.Native.dll | `6FC1C7BC779DC01E54CC317EE3BAB4EC0D1D07BF51722E579A840204F8C74F52` |
| Buwei.Windows.Core.dll | `89DF7791BD352C6310230FF29DF4436F8B4ACF0E6E3D1A12754E66F085852F1A` |
| Buwei.Windows.Native.pri | `03DE707BDFA986694065B00CBED7772668A5AB938828441B3EC0EA6DF304C6C1` |
| App.xbf | `D9561B1B7B994505358BBC821302A4C0D520115125F3328893B8B001FF8593A1` |

原安装记录指向的旧版 EXE 已不存在，因此本次基线是**当前桌面源码重新构建的 Tauri 0.1.1 Release**，不是声称重新测量了不存在的已安装文件。只覆盖构建配置中的 `identifier=cn.buwei.desktop.perf-20261019`、产品名；没有修改桌面源码。旧版 EXE SHA-256 为 `1E677CE96CD3C498A8F6620311E76AD75B7AF18021C6B29A3AFA3122D6CF8169`，源码 `desktop` 树为 `cb84913d688edc846bcf1412047a392fc6affbd8`。隔离目录在首次测试前不存在，原客户端配置和用户数据未被读取、重置或搬移。[构建命令及元数据](../../output/windows-native/resources/legacy-release-build.json)

原始文件位于主仓库交付目录 `output/windows-native/resources/`：

- [manifest.json](../../output/windows-native/resources/manifest.json)：机器、参数、版本、EXE/DLL 哈希与边界。
- [raw-samples.csv](../../output/windows-native/resources/raw-samples.csv)：每点进程树总量；[process-samples.csv](../../output/windows-native/resources/process-samples.csv)：逐进程原始计数器及父链。
- [trials.json](../../output/windows-native/resources/trials.json)、[summary.json](../../output/windows-native/resources/summary.json)：原始采样器汇总。
- [audit.json](../../output/windows-native/resources/audit.json)：独立重算、样本数量、父链审计与变化比例。
- [legacy-diagnostics.log](../../output/windows-native/resources/legacy-diagnostics.log)：旧版挂起请求结果。

首次预检曾因发布资源缺失/映射覆盖而启动失败，**未计入任何有效轮次**。失败 manifest、事件摘要和错误记录另存 [startup-failure-20261020](../../output/windows-native/resources/startup-failure-20261020/)。本报告只汇总修复后的 r2 数据。

## 重现与未覆盖项目

从仓库根目录，使用 [measure-resources.ps1](../scripts/measure-resources.ps1) 对独立匿名配置运行：

```powershell
Expand-Archive ./output/windows-native/Buwei.Windows.Native-0.1.0-x64-portable.zip `
  -DestinationPath ./output/windows-native/publish
& ./windows-native/scripts/measure-resources.ps1 `
  -NativeExe ./output/windows-native/publish/Buwei.Windows.Native.exe `
  -NativeArguments @('--benchmark') `
  -LegacyExe '<独立标识构建的 buwei-desktop.exe 路径>' `
  -LegacyIsolationDescription 'TAURI_CONFIG identifier cn.buwei.desktop.perf-20261019' `
  -Scenario Both -Trials 3 -WarmupSeconds 30 -SampleSeconds 60 `
  -OutputDirectory ./output/windows-native/resources-recheck `
  -AllowTerminateBenchmarkProcesses
python ./windows-native/scripts/audit-resources.py ./output/windows-native/resources-recheck
```

`NativeExe` 应替换为解压后的实际最终发布路径。采样器只终止自己启动并归属明确的测试进程；已有同路径进程会令测试拒绝启动。不要传入具有未保存工作或真实会话的旧版配置。

本轮未覆盖已登录项目、长列表、富文档/PDF、上传下载峰值、录制、实时语音、长期后台运行、GPU/VRAM、系统整体增量物理内存，以及安装包/共享运行时总磁盘成本。托盘工作集增加是本次保留的实际取舍，后续应在真实业务及内存压力场景继续验证；本次没有调用 `EmptyWorkingSet`、强制 GC 或修改程序来压低采样数字。
