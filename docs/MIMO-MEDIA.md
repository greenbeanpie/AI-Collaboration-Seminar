# 小米官方 MiMo 音视频理解

MiMo 是新增可选路径。上传音频默认仍为 Whisper 优先，视频默认仍为 Gemini。实时语音与系统本地朗读不受此配置影响。模型固定为 `mimo-v2.6-pro`，官方端点为 `https://api.xiaomimimo.com/v1`。

## 管理员配置

进入设置 → AI 模型接入与测试，勾选“配置 MiMo 音视频摘要模型”，填写 API Key 后保存。留空保留已保存密钥，密钥不回显。该配置与 Gemini 分开保存，保存配置本身不切换处理策略。

仅需要处理音频时，在“音频文件处理策略”选择“MiMo 直接理解”；视频策略可继续保留 Gemini。“测试 MiMo 模型元数据”仅调用模型列表，不能证明真实音频质量。未配置密钥或文件读取地址时不运行任务。

## 文件与结果

当前上传上限保持 50 MiB。MiMo 支持本系统现有的 MP3、WAV、M4A、MP4；WebM 请切换旧路径处理。整文件理解不承诺逐字转录，生成结果标识为 AI 摘要。视频默认每秒抽取 2 帧，可能遗漏瞬时画面与细节；不等同逐帧覆盖。

R2 桶保持私有。后端 `MEDIA_FETCH_BASE_URL` 指向部署后的后端 HTTPS Origin，生成 15 分钟有效的文件读取签名，绑定任务、文件和生命周期。只有正在生成且持有有效租约的 MiMo 任务可读；完成、失败、取消、草稿提交或文件删除会撤销读取权限。链接不返回普通客户端，不存入应用调用记录，响应禁止缓存。认证失败返回统一 404。

任务冻结处理路径和配置版本；保存新配置不会改变旧任务。MiMo 不会触发 Whisper 或 Gemini 回退，不进入自动 AI 重试。网络、超时及输出失败保留原文件；结果未知的请求不自动重放。管理员主动重新处理会发起新任务。未确认完整处理的合法部分摘要保留在任务状态，不发布为完整资料。

## 音频验收

真实测试只进行音频，不调用视频。使用已有私有管理员凭据及合成短 WAV：

```powershell
node scripts/verify-mimo-audio-production.mjs --production --credentials <private-admin.json> --check-config
node scripts/verify-mimo-audio-production.mjs --production --credentials <private-admin.json> --audio <synthetic.wav> --select-mimo-for-test --expect <spoken-keyword> --output output/mimo-release
```

第二条命令在上传前暂时选择 MiMo，上传冻结配置后立即恢复原策略。恢复使用配置版本校验，不能覆盖管理员同时保存的配置。测试仅提交一次，观察一分钟；超时保留原任务供稍后检查，不重复上传。短文件结果不能证明长音频完整覆盖；长音频与视频效果需要单独验证。

发布迁移为 `0060_mimo_media.sql`，仅增加供应商及用量字段。生产迁移前保存 D1 Time Travel 恢复点和关键表备份；回滚应用保留增量迁移、原文件及旧配置。

参考：[官方音频理解](https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/multimodal-understanding/audio-understanding)、[官方视频理解](https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/multimodal-understanding/video-understanding)。
