# Gemini 语音转录与答辩接入评估及实施计划

核查日期：2026 年 10 月 5 日。本次交付为源码评估和接入计划，尚未接入或启用新的语音模型，未进行收费模型实测。

结论：`gemini-3.5-transcribe-live` 已有 Google 官方文档；Cloudflare AI Gateway 已提供 Google 实时 WebSocket 转发。二者在协议层具备组合条件，但文档不能证明当前账户、Gateway 和该具体模型已兼容。推荐方案为 **Transcribe Live 仅转录 → 现有文字模型出题、追问和评分 → 独立 TTS 朗读已保存的问题**。只支持评委与答辩者轮流发言，播放结束后才能录音。通用 `gemini-3.5-live` 未在本次核查的官方模型目录中列出，不以类似名称的翻译模型替代。

## 当前实现和必须改变的边界

| 子系统 | 已实现行为 | 接入影响 |
| --- | --- | --- |
| 上传音频初步转录 | `backend/src/services/audio-pipeline.ts` 调用 Workers AI binding 的 `@cf/openai/whisper-large-v3-turbo`；转录保存在私有 R2 | 不是 Gemini，也未经过 Gateway；替换需要新 ASR 适配器和 PCM 解码来源 |
| 转录检查与总结 | 原生 Whisper 指标检查后，由 `visionEconomy` 检查文本，全部通过才由 `textEconomy` 分块总结与合并 | 保留现有文字模型职责；Gemini ASR 不提供 Whisper 指标时必须使用独立检查逻辑，不能伪造指标或沿用指标门槛 |
| 媒体回退 | `backend/src/ai/gemini-media.ts` 使用 Google Files 上传、查询、删除以及 `generateContent` 摘要 | 硬编码 Google 直连；严格 Gateway 模式必须迁移或禁用该回退，不能偷偷直连 |
| 模拟答辩 | `frontend/src/pages/RehearsalsPage.tsx` 是文本输入、提交回答和结束；未发现录音、浏览器 ASR 或 TTS 实现 | 这是新增语音输入与播放能力，不是更换现有语音供应商 |
| 出题和评分 | `review` 文字模型通过 `aiJsonCall` 生成首问、追问、点评；结束时冻结问答并评分 | 继续使用原链路、材料、标准、引用核验、预算及作业发布机制 |
| 网络入口 | `gatewayChat` 对非 Workers AI 使用配置中的 `apiUrl`，名称本身不保证 Gateway 转发 | Google 相关新请求必须由服务器构造固定 Gateway URL；若文字模型也是 Google，则其路径同样须验证为 Gateway |

现有答辩 API `POST .../rehearsals`、`.../answers`、`.../finish` 保留；回答正文仍为最多 8000 字符的 `content`。`processing_job_id` 保证同一轮只有一个处理作业；只有发起人可以操作，其他成员只读。语音层不得绕过这些规则，也不得根据临时字幕自动写入真实回答或发起评分。

## 官方证据和可行性判断

Google 的 [Live Transcription 文档](https://ai.google.dev/gemini-api/docs/live-api/live-transcribe) 描述专用模型 `gemini-3.5-transcribe-live`：音频输入、文本输出，区分临时字幕和最终转录，支持逐字模式与手动语音边界。推荐使用 `TEXT` 和 `VERBATIM`，避免整理模式改写答辩证据。输入采用 16 kHz 单声道 16 位小端 PCM，小块发送；浏览器压缩录音文件不能直接当 PCM 传入。

Cloudflare 的 [Realtime WebSockets 文档](https://developers.cloudflare.com/ai-gateway/usage/websockets-api/realtime-api/) 描述 Google 路由 `wss://gateway.ai.cloudflare.com/v1/{accountId}/{gatewayId}/google` 及 Gateway 认证。该页面示例没有验证 Transcribe Live 的具体模型。**协议可行**属于依据两份官方说明的工程推断，**当前账户可用和生产可用尚未实测**。

[Google 模型目录](https://ai.google.dev/gemini-api/docs/models) 中的 `gemini-3.5-live-translate-preview` 面向翻译，不作为答辩代理。当前需求无需让 Live 会话读取项目材料、调用工具、生成问题或评分，因此无需引入通用 Live 对话模型。

[Google TTS 文档](https://ai.google.dev/gemini-api/docs/speech-generation) 将独立 TTS 定位为文本朗读，列出 `gemini-3.8-flash-tts`、`gemini-3.8-flash-lite-tts` 等型号。建议优先验证 Flash-Lite 候选，使用单一预置声音，不做克隆、语音设计或多人配音。型号仅为候选，价格、账户权限和可用 API 版本须在开发时重新核查并冻结。不能把这些候选当成已经通过 Gateway 的配置。

Cloudflare [Google AI Studio REST 文档](https://developers.cloudflare.com/ai-gateway/usage/providers/google-ai-studio/) 提供 `https://gateway.ai.cloudflare.com/v1/{accountId}/{gatewayId}/google-ai-studio` 前缀。TTS 应使用通过 Gateway 实测成功的 REST 资源和对应版本的请求结构；3.8 文档主示例采用 Interactions，不能直接套旧模型的 `generateContent` 请求体。若候选所需资源无法转发，维持文字功能并记录阻塞，不直连 Google，不无声更换型号。

## 目标架构和接口

浏览器只连接本项目 Worker。服务端持有 Gateway Token 和 Google key，或使用已验证的 Gateway BYOK；浏览器不获得供应商密钥、Gateway 长期 Token 或含密钥的连接地址。Worker 到外部只允许以上两个 Gateway 域名路由，拒绝重定向，错误诊断去除认证信息。

### 初步音频转录

1. 新增独立 `audioTranscription` 配置槽，保存模型、Gateway 标识、启用状态、语言提示和已核查价格；增加 `gemini-transcribe-first` 策略，默认不启用。与媒体摘要配置分开冻结，避免一个型号承担不同协议职责。
2. ASR 适配器将最终转录归一化为提供者、模型、文本、音频时长、音频覆盖范围、可用时间信息及完整性状态。缺失字段保持未知；不得以空值填出 Whisper 质量指标，不声称有提供者未返回的词级时间戳。
3. 保留私有 R2 中间结果、分块检查、文字摘要和断点恢复。文本检查仅能判断文本内在问题，不能证明识别准确率；没有原生置信度时报告这一限制。对音频内容明显异常或覆盖不完整的结果进入待人工处理，不能重复请求摘要冒充成功。
4. 先支持经过可靠解码的 PCM/WAV 输入。在现有 Workers 中不能假设具备 MP3、M4A 等解码能力；验证可部署的服务端解码方案后才扩大格式范围。长文件按确定的音频时间窗口解码、转录并保存检查点，不把一次短语音 WebSocket 测试当成四小时文件验收。当前四小时边界保持，实际模型会话限制、窗口尺寸和跨窗口边界去重规则须经长音频 PoC 冻结。
5. Google Files API 包含二阶段 resumable 上传地址，普通 Gateway `generateContent` 文档不足以证明全链路可代理。新严格模式不使用未经验证的旧直连摘要回退。若 Files 上传、轮询及删除无法全部经 Gateway，停止该回退并展示需要人工处理；旧路径迁移属于必要兼容工作，不能只替换生成 URL。

### 两方轮流答辩

顺序固定为：生成并保存评委文本 → TTS 合成 → 播放 → 用户点击开始回答 → ASR 字幕 → 停止回答并等待最终转录 → 用户核对/编辑 → 提交现有文字答案 → 原文字作业生成下一问。播放、录音、提交、生成下一问互斥；首版不支持打断、全双工、自动抢话或自动提交。

- 新增 `POST .../rehearsals/{id}/voice-sessions`，请求仅携带当前问题序号和期望版本，返回本项目会话 ID、期限和本项目 WebSocket 地址。创建和连接均检查发起人、项目成员身份、演练状态、当前问题及预算；浏览器不得自选 provider、model、system prompt 或工具。
- Worker 构造固定 ASR setup，仅发送当前回答音频及少量经过授权的术语提示，不传项目材料、历史问答或评分标准。通过 AudioWorklet 重采样 PCM，手动开始/结束；最终片段按本项目单调序号存储，临时字幕只显示、可覆盖。
- `POST .../rehearsals/{id}/turns/{sequence}/speech` 返回 202 与 TTS 作业 ID；请求不接收自定义朗读文本，服务端从已保存的评委回合获取文本。TTS 仅收到该回合文字和固定声音参数，不携带业务上下文。
- 音频按回合、正文摘要值、配置版本和声音参数去重，存于私有 R2，通过成员权限 API 提供播放；音频 MIME 以实际响应为准。重播读取同一成品，不重新收费。使用默认单请求音频输出，首版不做流式 TTS，以减少协议复杂度。
- 新增会话与音频记录表，关联演练 ID、序号、创建者、配置版本、状态、用量及成品对象；ASR 和 TTS 各自审计收费尝试。原 `rehearsal_turns` 仍以保存的文字作为评分证据，ASR 未确认文本不进入问答历史。
- 首版每次回答最长 10 分钟，单场单用户最多一个录音会话；PCM 缓冲最大 5 秒，超过背压边界立即暂停并提示，不无限堆积。用户停止录音后最多等待 15 秒获取最终文本，超时保留已确认片段，提示重录未确认部分或编辑文本；未确认完整的录音不能自动提交。

## 失败恢复和验证要求

每分钟自动重试由统一持久作业恢复层管理，不在页面或 WebSocket 的多个层次同时重试。收费尝试有独立记录；成功的转录窗口、已保存问答及 TTS 成品不重复生成。断线时停止麦克风，保留最终确认的文本；新会话不得把已确认语音全量重放。若需要继续识别，等待一分钟后重建会话并提示用户恢复录音。语音输入本身不能在没有用户输入时凭空重试；未知收费状态保留审计信息，重试仍受额度和生命周期检查约束。

TTS 失败保留已保存的问题与阅读能力；ASR 失败保留文本编辑和现有回答提交能力。权限撤回、演练结束、问题序号变化、预算不足、配置缺失应终止新请求，不能定时无限重试。取消任务关闭上游连接并释放麦克风；若请求已发出，取消不等于已免除供应商费用。

实施按以下门槛推进，任一真实模型门槛失败即保留功能关闭并报告原因：

1. **Gateway PoC**：使用正式拟用账户，获取 ASR setup 成功响应，传入中文样本，收齐临时与最终字幕；验证手动结束、断线和模态限制。TTS 通过 Gateway REST 返回可播放中文音频，人工核对与输入文字一致。保存脱敏请求协议、型号、版本、用量与失败记录。此阶段不调用 Google 直连作对照。
2. **上传音频 PoC**：同一内容的 WAV、MP3、M4A、静音、噪音、专业术语和中英混合样本；检查解码后覆盖与音频总时长、跨窗口重复/漏字、原文件保留和取消恢复。核查长文件时间定位，不使用编造时间点。初期将中文样本准确性人工核对和关键事实无误作为接受条件，不宣称固定准确率。
3. **接口与状态测试**：其他成员不能录音/合成；旧问题不能写回；重复请求和多设备并发不创建重复回答/音频；转录与 Whisper 指标分离；麦克风拒绝、无声输入、字幕超时、TTS 空音频、超额与停用均有可操作错误。所有 Google 出站 fetch/WebSocket 地址断言为 Gateway，直连域名和重定向拒绝。
4. **浏览器验收**：在目标 macOS Chrome/Safari 实际授权麦克风；播放期间无法录音，结束播放后可开始；最终字幕可修改，提交后数据库仅一个回答，现有文字模型正常追问和结束评分。重播不收费；刷新后恢复已保存历史，不自动开启麦克风。
5. **发布**：在独立 worktree 实现，更新 API 类型与迁移；运行类型检查、相关测试和构建，合并提交、推送，部署现有后端/前端 Worker。部署前配置私有存储与 Gateway 凭据，完成迁移；少量真实账户灰度验证后才打开语音开关。回滚通过关闭新策略保留原文字答辩和已保存证据。

尚未验证：目标 Gateway 对 Transcribe Live 的具体型号兼容、账户配额与计费、TTS REST 资源兼容、长音频服务端解码与会话限制、生产浏览器音频行为。此报告不将文档支持、模拟测试或部署成功等同于以上验收。
