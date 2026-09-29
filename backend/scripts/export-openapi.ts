import { mkdirSync, writeFileSync } from 'node:fs';
import { createApp } from '../src/app';

const app = createApp();
const doc = app.getOpenAPI31Document({
  openapi: '3.1.0',
  info: {
    title: '「补位」AI 项目办公室 API',
    version: '0.1.0',
    description:
      '契约唯一来源：前端 MSW 以此为依据。接口契约由双方共同确认，不得单方面修改（见 backend_plan.md 第 1 节）。',
  },
  servers: [{ url: '/api/v1' }],
});

const outDir = new URL('../openapi/', import.meta.url);
mkdirSync(outDir, { recursive: true });
writeFileSync(new URL('openapi.json', outDir), JSON.stringify(doc, null, 2) + '\n');
console.log('openapi/openapi.json 已生成');
