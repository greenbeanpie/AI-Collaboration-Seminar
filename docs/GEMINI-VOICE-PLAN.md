# 音频模型设置与两方轮流语音答辩

本轮按 2026 年 10 月 5 日的新要求实现设置拆分和语音答辩。文件初步转录仅保留 Whisper；实时发言使用 Gemini Transcribe Live；系统本地 TTS 朗读已保存问题，现有文字模型负责出题、追问与评分。语音失败切回文本，保留最终字幕和已编辑回答。真实 Google 实时转录、麦克风质量与账户配额验收须在专用凭据配置后完成，不把本地 fixture 验证当作模型验收。

## 模型与策略分离

| 设置 | 保存字段 | 实际职责 |
| --- | --- | --- |
| 音视频处理模型 | `mediaUnderstanding` | 保留既有音视频理解、摘要模型；独立于转录配置 |
| 音频文件初步转录模型 | `audioFileTranscription` | 固定 Workers AI 的 `@cf/openai/whisper-large-v3-turbo`，不提供 Gemini 文件转录选项 |
| 实时语音转录模型 | `realtimeAudioTranscription` | 固定 `gemini-3.5-transcribe-live`，独立 Gateway ID、Google API key、Cloudflare AI Gateway 认证令牌与语言提示 |
| 答辩朗读模型 | `rehearsalSpeech` | 系统本地语音，设置语言、语速与音量；无需 Gateway 凭据 |
| 音频与答辩处理策略 | `processingStrategies` | 音频文件选 Whisper 优先或直接音视频理解；答辩选文本或轮流语音并允许文本回退 |

“直接音视频理解”生成摘要，不是另一种文件转录。视频继续使用音视频处理模型。Whisper 转录后的质量检查与分块总结沿用现有图文/文字模型，原有质量门槛保留。默认策略为 Whisper 优先、文字答辩。

旧 `audioProcessingStrategy` 按原有语义映射，仍兼容旧客户端；新策略字段为新客户端的权威配置。配置仅新增版本，不改写冻结版本。音频设置保存保留文字模型启用状态和同等配置的探测结果，不主动调用或收费。专用密钥分别加密保存，不回显、不写入浏览器存储、不自动复制原媒体密钥；支持保留与显式清除。

## 语音链路和交互

用户在设置中选择轮流语音策略并补齐凭据后，可在自己的答辩轮次选择语音或文本。问题仍由现有文字作业生成并保存；点击“播放问题”时由浏览器调用设备的本地语音朗读。录音在用户点击后才请求麦克风权限，播放、合成、录音和提交互斥。停止录音后等待最终转录，用户核对/编辑后才调用原有回答 API，不自动提交、不代替评分。

录音经 AudioWorklet 从实际硬件采样率重采样为 16 kHz 单声道 PCM16 小端，以约 100 ms 片段发送。临时字幕只展示；最终字幕按事件序号去重，追加至原回答，不覆盖用户输入。超过回答上限的内容仍显示在字幕中供整理。单次会话上限十分钟、排队音频上限五秒；结束后最多等待十五秒最终结果。

ASR、麦克风、网络或 TTS 生成失败时明确切回文字，关闭麦克风/连接并保留文本。再次录音需要用户主动点击；失败会话恢复间隔至少六十秒，最多三次，随后由用户主动开启新周期。不自动打开麦克风，不用 Whisper 或浏览器语音识别替换实时模型。本地朗读失败时仍可直接阅读已保存文字。

本地朗读固定选择 `localService === true` 的系统声音，等待异步声音列表，分段逐字播放。没有可用本地声音或播放失败时回退文字，不使用远程声音或云端合成。停止、切换模式、新题、权限撤回及卸载会取消本组件的朗读，并防止迟到回调更新新题。文字模式与实时转录未配置时也可朗读已保存问题。旧云端 TTS 待执行任务取消，新合成接口返回 410，历史音频保持只读；不再创建云端 TTS 或自动重试。

## Gateway 与接口

新增实时 ASR 请求只能访问 Cloudflare AI Gateway；浏览器只连接本项目接口，不得到供应商密钥或 Gateway 长期 token。ASR 固定 Google `/google` WebSocket 通道，服务端发送专用 TEXT、VERBATIM 与手动语音边界配置；不转发客户端自选模型、工具、系统提示或项目材料。本地 TTS 不发送问题文字至合成服务器。既有 `gemini-media.ts` 的媒体上传/摘要路径保持旧实现，不能把本轮新增语音的 Gateway 保证扩展为全项目媒体已迁移。

以下接口均位于 `/api/v1/projects/{projectId}/rehearsals/{rehearsalId}`：

- `GET /voice` 返回配置/权限准备状态和实际策略；`ready` 不等于真实模型验收通过。
- `POST /voice-sessions` 接收当前问题序号，可带 `retryOfSessionId`，返回本项目 WebSocket 路径、会话 ID 和期限；`/voice-sessions/{id}/close` 幂等关闭。
- `GET /voice-sessions/{id}/stream` 通过认证和 Origin 检查后升级。客户端仅可发送开始、顺序 PCM 片段和结束；服务端仅返回准备、临时/最终字幕、完成或安全错误。
- 旧 `POST /turns/{sequence}/speech` 已退役，返回 410；历史 `GET /speech/{id}` 和 `/audio` 仅供授权读取。当前播放直接使用已显示的评委文字与本地系统声音，不调用这些接口。

只有当前答辩发起人可创建录音和朗读。每次连接、音频事件、调用前及发布时校验会话、项目、成员权限和当前问题；只有一个活跃录音，录音与本地朗读互斥；只有实时转录占用项目 AI 并发槽位，本地朗读不创建云端作业。

## 配置与上线验证

使用项目现有 Gateway `team-colleboration` 或管理员指定的有效 Gateway。在实时语音区填写 Google API key 与 Cloudflare 控制台为该 Gateway 创建的认证令牌（需 AI Gateway Run 权限）；后者通过 `cf-aig-authorization: Bearer ...` 头认证 Gateway，不是 Google API key 或模型供应商密钥。凭据只填设置页，不放入聊天、仓库或日志。新策略默认文字；切换为语音后仍由用户选择是否开始录音。

迁移 `0058/0059` 新增私有会话与 TTS 记录；cron 清理过期会话和并发预占，R2 GC 按音频记录及精确成品键保留有效音频。回滚时优先将策略设为文字，保留已保存回答、字幕及历史音频；不删除业务记录。

本地验证覆盖配置兼容及凭据脱敏、完整应用 WebSocket 升级、逐字转录协议、权限/轮次/并发检查、ASR/TTS 互斥、字幕留存和文本回退、PCM 重采样、本地声音筛选、取消和云 TTS 退休、桌面/手机界面。可复现浏览器检查运行 `scripts/verify-voice-defense-ui.cjs`，所有 API、麦克风和模型连接使用本地 fixture。

真实验收需使用 Gateway 收到中文实时最终字幕，并验证系统本地声音可朗读中文，再用真实麦克风检查 Chrome/Safari 授权、无声输入、专业词语、网络断开、播放结束后录音、文本编辑与一次提交。没有专用凭据或账户模型权限时，明确保留未验证状态与文字回退，不宣称语音已经生产验收。

官方依据：[Google 实时转录](https://ai.google.dev/gemini-api/docs/live-api/live-transcribe)、[系统本地声音](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesisVoice/localService)、[Cloudflare 实时 WebSocket 转发](https://developers.cloudflare.com/ai-gateway/usage/websockets-api/realtime-api/)、[Google 原生 REST 转发](https://developers.cloudflare.com/ai-gateway/usage/providers/google-ai-studio/)。
