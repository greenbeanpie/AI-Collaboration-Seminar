import type { ReactNode } from 'react';

/** Deliberately small Markdown subset. React escapes all text; no HTML, images or autoloads. */
function inline(text: string): ReactNode[] {
  return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|!?\[[^\]\n]*\]\([^\s)]*\))/g).map((part, i) => {
    if (part.startsWith('![')) return <span key={i}>[图片已隐藏]</span>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={i}>{part.slice(1,-1)}</code>;
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{part.slice(2,-2)}</strong>;
    const link = /^\[([^\]]*)\]\(([^)]*)\)$/.exec(part);
    if (link) {
      try { const url = new URL(link[2]); if (url.protocol === 'https:' && !url.username && !url.password) return <a key={i} href={url.href} rel="noreferrer noopener" target="_blank">{link[1]}</a>; } catch { /* plain text */ }
      return <span key={i}>{link[1]}</span>;
    }
    return part;
  });
}
export function ProfileMarkdown({ value }: { value: string }) {
  return <div className="profile-markdown">{value.split('\n').map((line,i) => {
    if (line.startsWith('### ')) return <h4 key={i}>{inline(line.slice(4))}</h4>;
    if (line.startsWith('## ')) return <h3 key={i}>{inline(line.slice(3))}</h3>;
    if (line.startsWith('# ')) return <h2 key={i}>{inline(line.slice(2))}</h2>;
    if (/^[-*] /.test(line)) return <p key={i}>• {inline(line.slice(2))}</p>;
    return <p key={i}>{inline(line) || '\u00a0'}</p>;
  })}</div>;
}
