import { AppError } from '../core/errors';
import { LIMITS } from '../core/limits';

const PRIVATE_HOST_RE = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/i;
const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;

export interface FetchedPage {
  url: string;
  finalUrl: string;
  title: string;
  text: string;
}

/**
 * 网页抓取（PLAN 二.4）：仅允许域名白名单、公开 HTTP(S)、逐跳校验重定向、
 * 禁 userinfo/非常规端口/内网地址、限大小与超时；不携带用户 Cookie。
 * 白名单存 app_config key='web_fetch_allowlist'（JSON 字符串数组，运营维护）。
 */
export async function fetchWebPage(
  env: { DB: D1Database },
  startUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FetchedPage> {
  const allowRow = await env.DB
    .prepare("SELECT value_json FROM app_config WHERE key = 'web_fetch_allowlist'")
    .first<{ value_json: string }>();
  const allowlist: string[] = allowRow ? (JSON.parse(allowRow.value_json) as string[]) : [];

  const assertAllowed = (raw: string): URL => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new AppError('SOURCE_PARSE_FAILED', '无效的网页地址', 422, false);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new AppError('SOURCE_PARSE_FAILED', '仅支持公开 HTTP(S) 网页', 422, false);
    }
    if (url.username || url.password) {
      throw new AppError('SOURCE_PARSE_FAILED', '不支持携带用户信息的地址', 422, false);
    }
    if (url.port && url.port !== '80' && url.port !== '443') {
      throw new AppError('SOURCE_PARSE_FAILED', '不支持非常规端口', 422, false);
    }
    const host = url.hostname;
    if (PRIVATE_HOST_RE.test(host)) {
      throw new AppError('SOURCE_PARSE_FAILED', '不允许访问内网地址', 422, false);
    }
    const inList = allowlist.some((pattern) => host === pattern || host.endsWith(`.${pattern}`));
    if (!inList) {
      throw new AppError('SOURCE_PARSE_FAILED', `域名 ${host} 不在允许列表中，请改用文件或文字导入`, 422, false, {
        host,
      });
    }
    return url;
  };

  let current = assertAllowed(startUrl);
  const started = Date.now();
  for (let hop = 0; hop <= 5; hop++) {
    const res = await fetchImpl(current.toString(), {
      redirect: 'manual',
      signal: AbortSignal.timeout(LIMITS.webFetchTimeoutMs),
      headers: { 'user-agent': 'AI-Office-Bot/1.0' },
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new AppError('SOURCE_PARSE_FAILED', '重定向缺少目标地址', 422, false);
      current = assertAllowed(new URL(location, current).toString());
      continue;
    }
    if (!res.ok) {
      throw new AppError('SOURCE_PARSE_FAILED', `网页返回 ${res.status}`, 422, true);
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
      throw new AppError('SOURCE_PARSE_FAILED', `不支持的内容类型 ${contentType.split(';')[0]}`, 422, false);
    }
    const reader = res.body?.getReader();
    let html = '';
    if (reader) {
      const decoder = new TextDecoder();
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > LIMITS.webFetchMaxBytes) {
          await reader.cancel();
          throw new AppError('SOURCE_PARSE_FAILED', '网页内容超过大小限制', 422, false);
        }
        html += decoder.decode(value, { stream: true });
      }
      html += decoder.decode();
    }
    if (Date.now() - started > LIMITS.webFetchTimeoutMs) {
      throw new AppError('SOURCE_PARSE_FAILED', '网页读取超时', 422, true);
    }
    return { url: startUrl, finalUrl: current.toString(), title: extractTitle(html), text: htmlToText(html) };
  }
  throw new AppError('SOURCE_PARSE_FAILED', '重定向次数过多', 422, false);
}

function extractTitle(html: string): string {
  const m: RegExpMatchArray | null = html.match(TITLE_RE);
  return m?.[1] ? m[1].trim().slice(0, 200) : '未命名网页';
}

/** 极简 HTML → 文本：去 script/style/标签、解常见实体、合并空白 */
function htmlToText(html: string): string {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
