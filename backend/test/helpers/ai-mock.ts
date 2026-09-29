import { vi } from 'vitest';

export interface GatewayMockOptions {
  /** 第一次要求提取调用返回非法 JSON，触发一次修复重试 */
  repair?: boolean;
  /** 返回伪造 fragmentId 的引用（应导致 AI_OUTPUT_INVALID） */
  fabricatedCitation?: boolean;
  /** 只审模式返回伪造引文（应导致 AI_OUTPUT_INVALID） */
  fabricatedAgentQuote?: boolean;
}

interface ChatBody {
  messages?: Array<{ role: string; content: unknown }>;
  model?: string;
}

function openAiResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 42, completion_tokens: 17 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

const FRAG_RE = /\[frag:([0-9a-f-]{36}) 页(\d+|-) \w+\]\n([^\n]+)/;

/**
 * AI Gateway mock：
 * - 视觉调用（content 数组含 image_url）→ OCR JSON
 * - 要求提取（system 含「比赛通知解析助手」）→ 引用真实片段的要求 JSON
 * - 其他 → 中文回复（能力探测用）
 */
export function mockGatewayFetch(options?: GatewayMockOptions) {
  let textCalls = 0;
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as ChatBody;
    const first = body.messages?.[0]?.content;
    if (Array.isArray(first)) {
      return openAiResponse(
        '{"text": "扫描页内容：作品提交截止日期为 2026-10-08，团队人数不超过 5 人。", "confidence": 0.92}',
      );
    }
    const systemText = String(first ?? '');
    if (systemText.includes('比赛通知解析助手')) {
      textCalls++;
      if (options?.repair && textCalls === 1) {
        return openAiResponse('抱歉，这不是 JSON。');
      }
      const userContent = String(body.messages?.[1]?.content ?? '');
      const m: RegExpMatchArray | null = userContent.match(FRAG_RE);
      const fragmentId = options?.fabricatedCitation
        ? '11111111-1111-4111-8111-111111111111'
        : (m?.[1] ?? '00000000-0000-4000-8000-000000000000');
      const pageNumber = m?.[2] && m[2] !== '-' ? Number.parseInt(m[2], 10) : null;
      const quote = (m?.[3] ?? '原文').slice(0, 12);
      return openAiResponse(
        JSON.stringify({
          requirements: [
            {
              category: 'deadline',
              title: '作品提交截止',
              detail: '参赛作品须在截止日期前提交',
              dueDate: '2026-10-08',
              duePrecision: 'date',
              citations: [{ fragmentId, pageNumber, quote }],
            },
          ],
        }),
      );
    }
    if (systemText.includes('团队写作助手')) {
      return openAiResponse(
        JSON.stringify({ title: 'AI 生成草稿', markdown: '# AI 草稿\n\n这是 **AI** 生成的内容，待人工复核。' }),
      );
    }
    if (systemText.includes('「带做」模式助手')) {
      return openAiResponse(JSON.stringify({ type: 'question', content: '你们目前收集到哪些比赛要求？' }));
    }
    if (systemText.includes('审阅助手')) {
      return openAiResponse(
        JSON.stringify({
          issues: [
            {
              severity: 'high',
              title: '缺少成效数据',
              detail: '作品介绍没有应用成效部分',
              suggestion: '补充真实试用数据或标注待填写',
              quote: options?.fabricatedAgentQuote ? '这句引文在材料中不存在' : '本作品面向组队作业场景',
            },
          ],
        }),
      );
    }
    return openAiResponse('你好，我是中文助手。');
  });
}
