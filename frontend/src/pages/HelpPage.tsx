import { useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Download, Search } from 'lucide-react';
import { PageHeading } from '../components/ui';
import userGuide from '../help/USER-GUIDE.md?raw';
import technicalGuide from '../help/TECHNICAL-IMPLEMENTATION.md?raw';
import databaseGuide from '../help/DATABASE-SCHEMA.md?raw';
import './HelpPage.css';

const documents = {
  user: { label: '使用说明', filename: 'USER-GUIDE.md', content: userGuide, detail: '从加入项目到提交成果，按实际操作顺序阅读。' },
  technical: { label: '技术实现', filename: 'TECHNICAL-IMPLEMENTATION.md', content: technicalGuide, detail: '系统技术说明：数据库、AI 调用链路、开发验证和排障。' },
  database: { label: '数据库字典', filename: 'DATABASE-SCHEMA.md', content: databaseGuide, detail: '全部业务表的字段、约束、索引、外键及建表 SQL。' },
};

// Trusted bundled documentation, rendered as escaped React text without HTML execution.
function inline(text: string): ReactNode[] {
  return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^\s)]+\))/g).map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`')) return <code key={index}>{part.slice(1, -1)}</code>;
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>;
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (link) {
      if (/^\/app(?:[/?#]|$)/.test(link[2])) return <Link key={index} to={link[2]}>{link[1]}</Link>;
      try {
        const url = new URL(link[2]);
        if (url.protocol === 'https:' && !url.username && !url.password) return <a key={index} href={url.href} target="_blank" rel="noreferrer noopener">{link[1]}</a>;
      } catch { /* Unsupported links remain plain text. */ }
      return <span key={index}>{link[1]}</span>;
    }
    return part;
  });
}

function blocks(content: string): ReactNode[] {
  const lines = content.trim().split('\n');
  const result: ReactNode[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index].trim();
    if (!line) { index++; continue; }
    if (line.startsWith('```')) {
      const key = index; const language = line.slice(3).trim(); const code: string[] = []; index++;
      while (index < lines.length && !lines[index].trim().startsWith('```')) { code.push(lines[index]); index++; }
      if (index < lines.length) index++;
      result.push(<pre key={key} aria-label={language ? `${language} 示例` : '代码示例'}><code>{code.join('\n')}</code></pre>);
      continue;
    }
    const heading = /^(#{1,3}) (.+)$/.exec(line);
    if (heading) { result.push(<h3 key={index}>{inline(heading[2])}</h3>); index++; continue; }
    if (line.startsWith('|') && /^\|[\s:|-]+\|$/.test(lines[index + 1]?.trim() ?? '')) {
      const cells = (row: string) => row.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
      const header = cells(line); const rows: string[][] = []; const key = index; index += 2;
      while (lines[index]?.trim().startsWith('|')) { rows.push(cells(lines[index])); index++; }
      result.push(<div className="help-table" key={key}><table><thead><tr>{header.map((cell, i) => <th scope="col" key={i}>{inline(cell)}</th>)}</tr></thead><tbody>{rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{inline(cell)}</td>)}</tr>)}</tbody></table></div>);
      continue;
    }
    const list = /^(?:[-*] |\d+\. )/.exec(line);
    if (list) {
      const ordered = /^\d/.test(line); const start = ordered ? Number.parseInt(line, 10) : undefined; const items: ReactNode[] = []; const key = index;
      const pattern = ordered ? /^\d+\. / : /^[-*] /;
      while (index < lines.length && pattern.test(lines[index].trim())) {
        items.push(<li key={index}>{inline(lines[index].trim().replace(pattern, ''))}</li>); index++;
      }
      result.push(ordered ? <ol key={key} start={start}>{items}</ol> : <ul key={key}>{items}</ul>); continue;
    }
    const paragraphs = [line]; const key = index; index++;
    while (index < lines.length && lines[index].trim() && !/^(?:#|```|\||[-*] |\d+\. )/.test(lines[index].trim())) { paragraphs.push(lines[index].trim()); index++; }
    result.push(<p key={key}>{inline(paragraphs.join(' '))}</p>);
  }
  return result;
}

export function HelpMarkdown({ value }: { value: string }) {
  return <>{blocks(value)}</>;
}

function chapters(content: string, kind: string) {
  const parts: string[] = ['']; let fenced = false;
  for (const line of content.replace(/\r/g, '').split('\n')) {
    if (line.trim().startsWith('```')) fenced = !fenced;
    if (!fenced && line.startsWith('## ')) parts.push(line.slice(3));
    else parts[parts.length - 1] += `\n${line}`;
  }
  return { intro: parts[0].trim().replace(/^# .+\n?/, '').trim(), sections: parts.slice(1).map((part, index) => {
    const end = part.indexOf('\n');
    return { id: `${kind}-section-${index + 1}`, title: end < 0 ? part : part.slice(0, end), content: end < 0 ? '' : part.slice(end + 1) };
  }) };
}
const parsedDocuments = { user: chapters(userGuide, 'user'), technical: chapters(technicalGuide, 'technical'), database: chapters(databaseGuide, 'database') };

export function HelpPage() {
  const [contentsOpen, setContentsOpen] = useState(false);
  const [params, setParams] = useSearchParams();
  const requested = params.get('doc');
  const kind = requested === 'technical' || requested === 'database' ? requested : 'user';
  const document = documents[kind];
  const query = params.get('q') ?? '';
  const { intro, sections } = parsedDocuments[kind];
  const search = query.trim().toLocaleLowerCase();
  const visible = sections.filter(section => `${section.title}\n${section.content}`.toLocaleLowerCase().includes(search));

  function download() {
    const url = URL.createObjectURL(new Blob([document.content], { type: 'text/markdown;charset=utf-8' }));
    const anchor = window.document.createElement('a');
    anchor.href = url; anchor.download = document.filename;
    window.document.body.append(anchor); anchor.click(); anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <div className="page-stack help-page">
    <PageHeading eyebrow="补位 · 阅读与参考" title="帮助文档" detail="使用说明介绍操作流程；技术实现与数据库字典记录系统结构和运行机制。" />
    <div className="card help-toolbar">
      <nav aria-label="文档选择" className="help-document-nav">
        {(['user', 'technical', 'database'] as const).map(key => <Link key={key} to={`/app/help?doc=${key}`} aria-current={kind === key ? 'page' : undefined} className={`button ${kind === key ? 'button-primary' : 'button-quiet'}`}>{documents[key].label}</Link>)}
      </nav>
      <label className="help-search"><Search size={17} aria-hidden="true" /><span className="help-sr-only">搜索当前文档</span><input type="search" value={query} placeholder="搜索当前文档，如：任务、版本" onChange={event => { const next = new URLSearchParams(params); next.set('q', event.target.value); setParams(next, { replace: true }); }} /></label>
      <button type="button" className="button button-quiet" onClick={download}><Download size={16} aria-hidden="true" />下载文档</button>
    </div>
    <div className="help-layout">
      <aside className="card help-contents"><div className="help-contents-heading"><h2>章节目录</h2><button className="button button-quiet button-small help-contents-toggle" type="button" aria-expanded={contentsOpen} aria-controls="help-chapter-links" onClick={() => setContentsOpen(open => !open)}>{contentsOpen ? '收起目录' : '展开目录'}</button></div><p>{document.label} · {visible.length} 个章节</p><nav id="help-chapter-links" aria-label="章节目录" data-expanded={contentsOpen}>{visible.map(section => <a key={section.id} href={`#${section.id}`}>{inline(section.title)}</a>)}</nav><Link className="help-support" to="/app/support">仍有疑问？提交支持工单</Link></aside>
      <article className="card help-article" aria-label={document.label} key={kind}>
        <header><h2>{document.label}</h2><p>{document.detail}</p>{!search && <HelpMarkdown value={intro} />}</header>
        {search && <p role="status">找到 {visible.length} 个相关章节</p>}
        {visible.length ? visible.map(section => <section key={section.id} id={section.id} className="help-section"><h2>{inline(section.title)}</h2><HelpMarkdown value={section.content} /></section>) : <div className="empty-state"><h3>未找到相关章节</h3><p>试试更短的关键词，或切换另一份文档。</p><button type="button" className="button button-quiet" onClick={() => setParams({ doc: kind })}>清除搜索</button></div>}
      </article>
    </div>
  </div>;
}
