export function sanitizeDiagnostic(value: string): string {
  return value.replace(/https?:\/\/[^\s)]+/g, raw => {
    try { const url = new URL(raw); return `${url.origin}${url.pathname}`; } catch { return '[地址已隐藏]'; }
  }).replace(/\b(Bearer\s+)\S+/gi, '$1[已隐藏]')
    .replace(/(["'])(password|token|cookie|authorization|secret|api[_-]?key)\1\s*:\s*(["'])(.*?)\3/gi, '$1$2$1:"[已隐藏]"')
    .replace(/\b(cookie|authorization)\s*:\s*[^\r\n]+/gi, '$1: [已隐藏]')
    .replace(/\b(password|token|cookie|authorization|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[已隐藏]');
}

export function errorDiagnostics(error: unknown, componentStack = '', capturedAt = new Date().toISOString()): string {
  const candidate = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const info = error instanceof Error ? error : new Error(typeof error === 'string' ? error : '未知错误');
  return JSON.stringify({
    time: capturedAt, build: import.meta.env.VITE_BUILD_VERSION ?? 'unknown',
    path: window.location.pathname, name: sanitizeDiagnostic(info.name), message: sanitizeDiagnostic(typeof candidate.diagnosticMessage==='string' ? candidate.diagnosticMessage : info.message),
    stack: sanitizeDiagnostic(info.stack ?? ''), componentStack:sanitizeDiagnostic(componentStack),
    requestId: typeof candidate.requestId === 'string' ? candidate.requestId : null,
    code: typeof candidate.code === 'string' ? candidate.code : null,
    stage: typeof candidate.stage==='string' ? sanitizeDiagnostic(candidate.stage) : null,
    action: typeof candidate.action==='string' ? sanitizeDiagnostic(candidate.action) : null,
    status: typeof candidate.status === 'number' ? candidate.status : null,
  }, null, 2);
}
