/** 全局限制常量。/capabilities 下发的值必须与此处硬校验一致。 */
export const LIMITS = {
  /** 单文件上传上限（按实际上传字节计） */
  maxFileBytes: 10 * 1024 * 1024,
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
  sessionTtlDays: 7,
  challengeTtlMinutes: 10,
  challengeMaxAttempts: 5,
  challengeResendSeconds: 60,
  invitationTtlDays: 7,
  webFetchMaxBytes: 5 * 1024 * 1024,
  webFetchTimeoutMs: 15_000,
  /** Gateway 每请求一次尝试之外，应用层允许的额外重试次数 */
  aiCallExtraRetries: 1,
  /** 隔离文件回收时限（小时） */
  quarantineGcHours: 48,
} as const;

/** 允许上传的扩展名与可检测的文件魔数（见 services/files.ts） */
export const ALLOWED_UPLOAD_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.txt', '.md'] as const;
