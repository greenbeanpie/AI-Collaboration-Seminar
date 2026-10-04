/** 全局限制常量。/capabilities 下发的值必须与此处硬校验一致。 */
export const LIMITS = {
  /** 单文件上传上限（按实际上传字节计） */
  maxFileBytes: 10 * 1024 * 1024,
  maxMediaBytes: 50 * 1024 * 1024,
  /** 单个 PDF 最大页数 */
  maxPdfPages: 30,
  /** 页面图片长边上限（像素） */
  pageImageMaxEdge: 2000,
  /** 页面图片单张上限 */
  pageImageMaxBytes: 2 * 1024 * 1024,
  listDefaultPageSize: 20,
  listMaxPageSize: 100,
  /** 每项目并行 AI 任务上限 */
  concurrentAiTasksPerProject: 2,
  /** 单次 AI 分工建议最多处理的未完成任务数 */
  assignmentSuggestionMaxTasks: 20,
  sessionTtlDays: 7,
  challengeTtlMinutes: 10,
  challengeMaxAttempts: 5,
  challengeResendSeconds: 60,
  invitationTtlDays: 7,
  webFetchMaxBytes: 5 * 1024 * 1024,
  webFetchTimeoutMs: 15_000,
  /** Gateway 每请求一次尝试之外，应用层允许的额外重试次数 */
  aiCallExtraRetries: 3,
  /** 隔离文件回收时限（小时） */
  quarantineGcHours: 48,
  /** 孤儿 R2 对象宽限期（天）：比这更晚的对象不参与清理，避免误删刚写入的数据 */
  orphanObjectGraceDays: 7,
  /** 单次 cron 最多删除的孤儿对象数（有界批处理） */
  orphanGcMaxObjectsPerRun: 200,
  /** 已完成幂等回放记录的保留天数；processing 记录不自动删除，需运维核对（见 A08） */
  idempotencyCompletedRetentionDays: 30,
} as const;

/** 允许上传的扩展名与可检测的文件魔数（见 services/files.ts） */
export const ALLOWED_UPLOAD_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.txt', '.md', '.mp3', '.wav', '.m4a', '.mp4', '.webm'] as const;
