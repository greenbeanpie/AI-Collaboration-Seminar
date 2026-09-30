# 前端联调指南（FRONTEND-INTEGRATION.md）

> 面向前端 AI / 前端同学。说明如何接入「补位」AI 项目办公室后端（`backend/` 分支）。
> 契约唯一来源：[`backend/openapi/openapi.json`](../openapi/openapi.json)（当前 32 条路径）。契约由双方共同确认，不得单方面修改。
>
> 更新日期：2026-09-29 ｜ 后端进度：M0–M3 已实现（登录/项目/成员/邀请/文件/来源解析/要求/评分标准/异步任务），**M4–M6 部分接口尚未实现，见第 8 节**。

---

## 1. 联调方式总览

后端是 Cloudflare Worker（Hono），**不返回 CORS 头**。前端有两种接法：

| 场景 | 接法 |
|---|---|
| 本地开发 | Vite dev proxy 把 `/api/*` 代理到 `http://127.0.0.1:8787`（同源，Cookie 自动携带） |
| 生产/预览 | 前端 Worker 通过 **Service Binding** 转发 `/api/*`（同进程调用，无跨域问题） |

不要尝试跨域直连后端域名（会被 Origin 白名单拒绝，也没有 CORS 响应头）。

**后端本地启动**：

```bash
cd backend
npm install
cp .dev.vars.example .dev.vars   # 本地密钥（已被 gitignore）
npm run dev                      # wrangler dev，默认 http://127.0.0.1:8787
```

**前端 Vite 代理示例**：

```ts
// vite.config.ts
export default defineConfig({
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false },
    },
  },
});
```

**Service Binding（生产/预览，前端 Worker 的 wrangler 配置）**：

```jsonc
// 前端 Worker wrangler.jsonc
{
  "services": [{ "binding": "API", "service": "ai-office-api-staging" }]
}
```

前端 Worker 收到 `/api/*` 后用 `env.API.fetch(request)` 原样转发即可。同时**必须把前端真实域名告知后端**加入 `ALLOWED_ORIGINS`（写请求会校验 Origin）。后端 Worker 服务名：`ai-office-api`（生产）/ `ai-office-api-staging`。

---

## 2. 统一调用约定

- Base path：`/api/v1`。完整契约见 openapi.json（也可运行中访问 `GET /api/v1/openapi.json`）。
- 成功响应：`{ "data": ..., "requestId": "<uuid>" }`，响应头带 `X-Request-Id`（前端可自带合法 UUID 透传用于链路追踪）。
- 失败响应：`{ "error": { "code", "message", "retryable", "details?" }, "requestId" }`。**请按 `code` 分流，不要按 message 匹配。**
- 参数校验失败：`400 VALIDATION_FAILED`，`details.issues = [{ path: ["字段名"], message }]`。

主要错误码：

| code | HTTP | 前端处理建议 |
|---|---|---|
| `UNAUTHENTICATED` | 401 | 跳登录（会话 7 天有效） |
| `AUTH_CHALLENGE_INVALID` | 400 | 提示验证码错误 |
| `AUTH_CHALLENGE_EXPIRED` | 410 | 重新发送验证码 |
| `AUTH_ATTEMPTS_EXCEEDED` | 429 | 锁死，须重新发起挑战 |
| `RATE_LIMITED` | 429 | 按 `details.resendAfterSeconds` 倒计时 |
| `PERMISSION_DENIED` | 403 | 非成员/角色不足/Origin 不在白名单 |
| `NOT_FOUND` | 404 | 资源不存在（项目不对外泄露存在性，非成员访问项目也返回 403，不存在的项目返回 404） |
| `VERSION_CONFLICT` | 409 | **乐观锁冲突**：`details.currentRevision` 为服务器当前版本，展示差异后带新 revision 重试 |
| `IDEMPOTENCY_CONFLICT` | 409 | 同 Idempotency-Key 不同请求体（幂等在 M4 落地） |
| `INVALID_STATE` | 409 | 状态机违规（重复确认、重复上传等） |
| `FILE_TOO_LARGE` | 413 | 超过 10 MiB |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | 文件头与扩展名不符 |
| `SOURCE_PARSE_FAILED` | 422 | 解析失败（加密 PDF/超页/白名单外域名等），`details` 有原因 |
| `QUOTA_EXCEEDED` | 429 | 人数已满 / AI 并发或预算不足 |
| `AI_OUTPUT_INVALID` | 502 | 模型输出不可用（含伪造引用） |
| `AI_UNAVAILABLE` | 503 | 模型/邮件服务不可用，可重试 |
| `EMAIL_UNAVAILABLE` | 503 | 验证码邮件发送失败 |

鉴权：Cookie `ai_office_session`（`HttpOnly; Secure; SameSite=Lax`）。经 dev proxy / service binding 转发时 Cookie 自动流转，前端无需读取。

---

## 3. 登录流程（验证码，当前为回显模式）

```ts
// 1. 请求验证码
const res = await fetch('/api/v1/auth/challenges', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'user@example.com' }),
});
// 201 → { data: { challengeId, expiresAt, resendAfterSeconds, devCode? } }
// devCode 仅在回显模式（EMAIL_MODE=echo，本地/演示）返回；生产环境没有该字段。

// 2. 验证码换会话（用户不存在会自动注册）
const login = await fetch('/api/v1/auth/sessions', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, challengeId, code }), // code 为 6 位数字
});
// 201 → Set-Cookie + { data: { user: { id, email, displayName } } }

// 3. 读取当前用户 / 退出
await fetch('/api/v1/auth/session');                    // GET → 当前用户
await fetch('/api/v1/auth/session', { method: 'DELETE' }); // 立即撤销会话
```

限制（429 触发条件）：同邮箱 60 秒内重复请求；同 IP 每小时 10 次；验证码错 5 次锁死（410/429 需重新发起挑战）。

---

## 4. 异步任务（202 + jobId 轮询）

`/parse`、`/page-images`、`/jobs/{id}/retry` 返回 `202 { data: { jobId } }`。轮询约定（与 PLAN 一.7 一致）：

```ts
// GET /api/v1/jobs/{jobId}
// { data: { jobId, kind, status, result, error, attempts, createdAt } }
// status: queued | running | waiting_input | succeeded | failed | cancelled
// 轮询间隔 2s 起步，逐次退避至 10s；页面不可见时暂停，恢复可见时立即查一次
```

- `succeeded` → `result` 为各 kind 的产物（如 parse 任务：`{ requirementSetId, count }`）。
- `waiting_input` → `result` 说明缺什么（如 `{ needsImages: 2, message: "存在扫描页…" }`），前端继续引导用户操作后由对应接口触发续跑。
- `failed` → `error = { code, message, details }`；可重试的任务 `POST /jobs/{id}/retry` 得到**新 jobId**（旧任务已终态）。

---

## 5. 文件与来源解析端到端

### 5.1 文件上传（两步）

```ts
// 1) 初始化（服务端分配 R2 key，客户端不能指定路径）
const init = await fetch(`/api/v1/projects/${projectId}/files`, {
  method: 'POST', headers: jsonHeaders,
  body: JSON.stringify({ fileName: '通知.pdf', contentType: 'application/pdf' }),
});
// 201 → { data: { fileId, upload: { method: 'PUT', url: '/api/v1/projects/{projectId}/files/{fileId}/content' } } }

// 2) 上传二进制（按实际上传字节校验 ≤10MiB）
await fetch(init.data.upload.url, { method: 'PUT', body: fileBlob });
// 201 → { data: { fileId, sizeBytes, sha256, mimeDetected } }
// 413/415 → 文件过大 / 类型不符；下载：GET upload.url（成员可读）
```

### 5.2 导入来源并发起解析

```ts
// 导入（kind: file | paste | web）
const src = await fetch(`/api/v1/projects/${projectId}/sources`, {
  method: 'POST', headers: jsonHeaders,
  body: JSON.stringify({ kind: 'file', fileId }),   // 或 {kind:'paste', text} / {kind:'web', url}
});
// 201 → { data: { sourceId, sourceVersionId, title, ... } }

// 发起解析
const job = await fetch(`/api/v1/projects/${projectId}/sources/${sourceId}/parse`, { method: 'POST', ... , body: '{}' });
// 202 → 轮询 jobId
```

解析成功后 `result.requirementSetId` 指向**草稿要求集**（重新解析产生新草稿，不覆盖已确认内容）。

### 5.3 扫描页（无文本层）的低成本识别配合

任务进入 `waiting_input`（`result.needsImages`）后：

```ts
// 1) 取待渲染页码
GET /api/v1/projects/{projectId}/sources/{sourceId}/render-requests
// → { data: { items: [{ pageNumber }] } }

// 2) 前端用 PDF.js 渲染这些页 → 图片（长边 ≤2000px，单张 ≤2MiB，PNG/JPEG/WEBP，
//    先走 5.1 两步上传得到 fileId）

// 3) 上传页面图（绑定 sourceVersionId + pageNumber）
POST /api/v1/projects/{projectId}/sources/{sourceId}/page-images
body: { sourceVersionId, images: [{ pageNumber: 1, fileId }, { pageNumber: 2, fileId }] }
// 202 → { data: { accepted, remaining, jobId? } }
// remaining=0 时返回 OCR jobId；OCR 完成后任务继续「要求提取」，产物同 5.2
```

OCR 片段带 `needs_review=true` 标记（识别方法和待确认状态会被保留，供人工核对）。

### 5.4 要求与评分标准

```ts
GET   /api/v1/projects/{projectId}/requirement-sets?sourceVersionId=...   // 列表（含草稿与已确认）
GET   /api/v1/projects/{projectId}/requirement-sets/{setId}               // 详情：requirements[] 每条带 citations[]
PATCH /api/v1/projects/{projectId}/requirements/{requirementId}           // 人工修改 → fieldState='edited'
POST  /api/v1/projects/{projectId}/requirement-sets/{setId}/confirm       // 仅负责人；重复确认 409

GET   /api/v1/projects/{projectId}/rubrics                                // 评分标准版本列表
POST  /api/v1/projects/{projectId}/rubrics                                // 新版本草稿 {source:'official'|'custom', weights:[{key,label,weight}], notes?}
PATCH /api/v1/projects/{projectId}/rubrics/{rubricId}                     // 改草稿（负责人）
POST  /api/v1/projects/{projectId}/rubrics/{rubricId}/confirm             // 确认（负责人）
```

引用结构（每条要求）：`citations: [{ sourceVersionId, fragmentId, pageNumber, quote }]`——`quote` 是来源原文逐字片段，前端可用于「依据跳转」高亮定位。

---

## 6. 项目 / 成员 / 邀请速查

```ts
POST   /api/v1/projects                                    // {name, description?, deadlineDate?} → 创建者即负责人
GET    /api/v1/projects?status=active|archived|all&cursor=&limit=   // 我参与的，游标分页 {items, nextCursor}
GET    /api/v1/projects/{projectId}                         // 详情（含 myRole、revision）
PATCH  /api/v1/projects/{projectId}                         // 负责人；必须带 expectedRevision，409 时按 details.currentRevision 重试

GET    /api/v1/projects/{projectId}/members                 // 成员列表（skills/hoursPerWeek 供分工建议）
GET|PATCH /api/v1/projects/{projectId}/members/me           // 我的信息 / 维护技能与投入时间
DELETE /api/v1/projects/{projectId}/members/{userId}       // 负责人移除成员（不可移除自己）
DELETE /api/v1/projects/{projectId}/members/me             // 成员退出（负责人不可退出）

POST   /api/v1/projects/{projectId}/invitations            // 负责人创建 {maxUses?, expiresInDays?} → code 仅返回一次
GET    /api/v1/projects/{projectId}/invitations            // 邀请列表（负责人）
DELETE /api/v1/projects/{projectId}/invitations/{iid}      // 撤销
POST   /api/v1/invitations/accept                          // {code} → 加入项目（人数满 429）
```

被移除成员的所有后续访问立即 403（前端应处理「成员被移出」的会话内提示）。

---

## 7. /capabilities 与能力协商

`GET /api/v1/capabilities`（公开）返回文件限制、分页上限、AI 并发数、比赛模板（如五人限制——仅是建议默认值，不硬编码）。**前端所有上限从这儿读，不要写死**：

```jsonc
{
  "data": {
    "apiVersion": "v1",
    "environment": "local",
    "features": { "aiEnabled": false, "webFetch": true, "emailMode": "echo" },
    "limits": {
      "maxFileBytes": 10485760, "maxPdfPages": 30,
      "pageImageMaxEdge": 2000, "pageImageMaxBytes": 2097152,
      "listDefaultPageSize": 20, "listMaxPageSize": 100,
      "concurrentAiTasksPerProject": 2
    },
    "competitionTemplate": { "teamSizeLimit": 5 }
  }
}
```

`features.aiEnabled=false` 表示模型尚未通过能力验证（当前默认），AI 相关界面应显示「模拟/未启用」。

---

## 8. 当前实现范围与剩余事项（2026-09-29 更新）

**PLAN 契约内的全部端点均已实现（55 条路径）**，包括 M4 的任务/材料/三档 AI 补位/采纳，与 M5 的预审/答辩/账本/导出。前端可对全部接口进行真实联调；`Idempotency-Key` 已在关键 POST（创建 AI 会话、采纳、发起预审）生效——建议所有关键 POST 都带上该头。

尚未完成、影响联调的事项：

| 事项 | 状态 | 影响 |
|---|---|---|
| 真实发信（Resend） | 等发信域名 | 验证码仍为回显模式（`devCode` 仅本地/演示返回） |
| 正式模型 | 等模型 Key（GLM/Gemini 等） | 当前 `/capabilities.aiEnabled=false`；启用前 AI 接口会返回 503 AI_UNAVAILABLE，前端需保留 MSW/演示分支 |
| staging/production 部署 | 待创建 Cloudflare 资源（docs/DEPLOY.md） | 生产联调与 Service Binding 实测在 M6 |
| 长期任务核对/压测/监控 | M6 | 不阻塞功能联调 |

三档 AI 与预审/答辩的接口行为提醒：

- `POST /agent-sessions`（冻结写请求 #1）返回 `{sessionId, runId, jobId}`；草稿在会话详情的 `turns[]`（`kind='draft'`，`payload.markdown/doc`）。
- 采纳（冻结 #2）`POST /agent-runs/{runId}/adopt`：`reviewed` 必须为 `true`，`doc` 为 Tiptap JSON；产生 `origin='ai_adoption'` 的新版本；同一 run 只能采纳一次（409）。
- 预审（冻结 #3）`POST /reviews` → 轮询 jobId → `GET /reviews/{id}` 的 `report` 绑定 `materialVersionIds`，材料更新后请提示「报告针对旧版本」。
- 答辩 `POST /rehearsals` → 第一问生成中 → `answers` 逐题 → `finish` 总结；演练结束后再答题返回 409。
- AI 产物均为**草稿语义**：AI 不会改任务状态或正式材料，一切以采纳/人工确认为准。

## 9. 联调验收清单（前端视角）

- [ ] 登录→会话恢复→退出全流程（回显模式）
- [ ] 创建项目→邀请→第二个账户接受→成员列表可见
- [ ] 两步文件上传；超限/伪造类型得到 413/415 并有清晰提示
- [ ] 粘贴文本导入→解析轮询→要求草稿渲染（引用可定位）→人工编辑→负责人确认
- [ ] 扫描 PDF 流程：waiting_input→render-requests→PDF.js 渲染上传→OCR 完成
- [ ] 项目 PATCH 乐观锁：人为制造 409 并按 currentRevision 恢复
- [ ] 未实现接口保持 MSW 模拟（不出现裸 404）
- [ ] 所有请求/响应 `requestId` 已接入前端日志

有任何契约问题：**先提出来双方确认，不要单方面改 openapi.json 的语义**（补充字段可协商）。
