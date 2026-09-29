export const nowIso = (): string => new Date().toISOString();

export const newId = (): string => crypto.randomUUID();

function toArrayBuffer(input: string | ArrayBuffer | Uint8Array): ArrayBuffer {
  if (typeof input === 'string') return new TextEncoder().encode(input).buffer as ArrayBuffer;
  if (input instanceof Uint8Array) {
    // 复制到独立 buffer，避免共享视图导致 digest 报错
    const copy = new ArrayBuffer(input.byteLength);
    new Uint8Array(copy).set(input);
    return copy;
  }
  return input;
}

export async function sha256Hex(input: string | ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 常数时间字符串比较（比较前先哈希抹平长度差） */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) {
    diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  }
  return diff === 0;
}
