/** 任务成果登记随请求提交的正文上限（字符）：后端硬校验与前端截断必须共用同一来源。 */
export const MAX_TASK_FILE_TEXT_CHARS = 60_000;

/** 超长截断时追加在正文末尾的说明；它本身也在 markdown 内，评分模型与用户都能感知缺失。 */
export const TASK_FILE_TEXT_TRUNCATION_NOTE = `（正文超过 ${MAX_TASK_FILE_TEXT_CHARS} 字符，已截断）`;
