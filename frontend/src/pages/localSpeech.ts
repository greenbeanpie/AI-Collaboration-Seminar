export type LocalSpeechSettings = { provider: 'system-local'; lang: string; rate: number; volume: number };
export const defaultLocalSpeech: LocalSpeechSettings = { provider: 'system-local', lang: 'zh-CN', rate: 1, volume: 1 };
const owners = new WeakMap<SpeechSynthesis, symbol>();
const normalizedLang = (lang: string) => lang.replaceAll('_', '-').toLowerCase();

/** Never pass an empty voice: the browser's implicit default may be a network voice. */
export function selectLocalVoice(voices: readonly SpeechSynthesisVoice[], lang: string): SpeechSynthesisVoice | null {
  const local = voices.filter(voice => voice.localService === true), desired = normalizedLang(lang);
  const exact = local.filter(voice => normalizedLang(voice.lang) === desired);
  const sameLanguage = local.filter(voice => normalizedLang(voice.lang).split('-')[0] === desired.split('-')[0]);
  return exact.find(voice => voice.default) ?? exact[0] ?? sameLanguage.find(voice => voice.default) ?? sameLanguage[0] ?? local.find(voice => voice.default) ?? local[0] ?? null;
}

export function waitForLocalVoice(synthesis: SpeechSynthesis, lang: string, signal: AbortSignal): Promise<SpeechSynthesisVoice> {
  return new Promise((resolve, reject) => {
    const clean = () => { clearTimeout(timer); synthesis.removeEventListener('voiceschanged', changed); signal.removeEventListener('abort', aborted); };
    const changed = () => { const voice = selectLocalVoice(synthesis.getVoices(), lang); if (voice) { clean(); resolve(voice); } };
    const aborted = () => { clean(); reject(new DOMException('朗读已取消', 'AbortError')); };
    const timer = setTimeout(() => { clean(); reject(new Error('系统没有可用的本地朗读声音，请安装系统语音包后再试；可继续文字回答。')); }, 2000);
    synthesis.addEventListener('voiceschanged', changed); signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted(); else changed();
  });
}

/** Keep exact text, split at sentence boundaries where possible, including all whitespace. */
export function localSpeechChunks(text: string, limit = 40): string[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('无效的朗读分段长度');
  const characters = Array.from(text), result: string[] = [];
  for (let offset = 0; offset < characters.length;) {
    let end = Math.min(offset + limit, characters.length);
    if (end < characters.length) {
      for (let index = end - 1; index > offset + limit / 2; index--) {
        if (/[。！？；.!?;\n]/u.test(characters[index])) { end = index + 1; break; }
      }
    }
    result.push(characters.slice(offset, end).join('')); offset = end;
  }
  return result;
}

export type LocalSpeechPlayback = { finished: Promise<void>; cancel: () => void };
export function speakLocal(text: string, settings: LocalSpeechSettings, onStart?: () => void): LocalSpeechPlayback {
  const controller = new AbortController(), owner = Symbol('local-rehearsal-speech');
  const synthesis = globalThis.speechSynthesis;
  let current: SpeechSynthesisUtterance | undefined, settled = false, segmentTimer: ReturnType<typeof setTimeout> | undefined;
  let overallTimer: ReturnType<typeof setTimeout> | undefined;
  let resolve!: () => void, reject!: (error: unknown) => void;
  const finished = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  const disposeCurrent = (cancel: boolean) => {
    clearTimeout(segmentTimer);
    if (current) { current.onstart = null; current.onend = null; current.onerror = null; }
    if (synthesis && owners.get(synthesis) === owner) {
      owners.delete(synthesis);
      if (cancel) synthesis.cancel();
    }
    current = undefined;
  };
  const finish = (error?: unknown) => {
    if (settled) return;
    settled = true; clearTimeout(overallTimer); controller.abort(); disposeCurrent(Boolean(error));
    if (error) reject(error); else resolve();
  };
  const cancel = () => finish(new DOMException('朗读已取消', 'AbortError'));
  const run = async () => {
    try {
      if (!synthesis || !globalThis.SpeechSynthesisUtterance) throw new Error('浏览器不支持系统本地朗读，可继续文字回答。');
      if (!text.trim() || text.length > 8000) throw new Error('当前问题为空或超过 8000 字，无法朗读。');
      if (settings.provider !== 'system-local' || !settings.lang || !Number.isFinite(settings.rate) || settings.rate < 0.5 || settings.rate > 2 || !Number.isFinite(settings.volume) || settings.volume < 0 || settings.volume > 1) throw new Error('系统朗读配置无效，请检查语言、语速和音量。');
      const voice = await waitForLocalVoice(synthesis, settings.lang, controller.signal);
      if (settled) return;
      const chunks = localSpeechChunks(text); let index = 0;
      overallTimer = setTimeout(() => finish(new Error('系统朗读超过 15 分钟，已停止；可继续文字回答。')), 900000);
      const next = () => {
        if (settled) return;
        if (index === chunks.length) { finish(); return; }
        if (synthesis.speaking || synthesis.pending || owners.has(synthesis)) { finish(new Error('系统正在进行其他朗读，请结束后重试。')); return; }
        current = new SpeechSynthesisUtterance(chunks[index++]);
        current.voice = voice; current.lang = settings.lang; current.rate = settings.rate; current.volume = settings.volume;
        current.onstart = () => { if (!settled) onStart?.(); };
        current.onerror = event => finish(new Error(`系统本地朗读失败（${event.error || 'unknown'}），可继续文字回答。`));
        current.onend = () => { if (settled) return; disposeCurrent(false); queueMicrotask(next); };
        owners.set(synthesis, owner);
        segmentTimer = setTimeout(() => finish(new Error('系统朗读响应超时，已停止；可继续文字回答。')), 60000);
        synthesis.speak(current);
      };
      next();
    } catch (error) { finish(error); }
  };
  void run(); return { finished, cancel };
}
