-- 0002_seed.sql —— 初始种子数据
-- AI 配置：Workers AI 兜底模型（经 AI Gateway 调用），enabled=0，
-- 由运维管理员运行能力探测（POST /admin/ai-config/probe）确认后 PUT 启用。
INSERT INTO ai_config_versions (id, version, config_json, enabled, notes, created_by, created_at)
VALUES (
  'cfg-seed-v1',
  1,
  '{
    "textEconomy": {
      "provider": "workers-ai",
      "model": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      "timeoutMs": 60000,
      "maxInputChars": 48000,
      "supportsJson": true,
      "supportsVision": false
    },
    "visionEconomy": {
      "provider": "workers-ai",
      "model": "@cf/meta/llama-3.2-11b-vision-instruct",
      "timeoutMs": 90000,
      "maxInputChars": 12000,
      "supportsJson": true,
      "supportsVision": true
    },
    "review": {
      "provider": "workers-ai",
      "model": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      "timeoutMs": 120000,
      "maxInputChars": 96000,
      "supportsJson": true,
      "supportsVision": false
    }
  }',
  0,
  '种子配置：中文/JSON/用量字段待能力探测验证。正式模型（GLM 等）到位后新增版本。',
  'system',
  '2026-09-29T00:00:00.000Z'
);

-- 本赛事模板：五人限制（仅作为创建项目时的默认建议，不硬编码为所有限制）
INSERT INTO app_config (key, value_json, updated_at)
VALUES ('competition_template', '{"teamSizeLimit": 5}', '2026-09-29T00:00:00.000Z');
