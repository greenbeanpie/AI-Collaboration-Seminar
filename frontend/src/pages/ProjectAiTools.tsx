import { useQuery } from '@tanstack/react-query';
import { api, projectPath } from '../api/client';
import { ErrorNotice } from '../components/ui';
function safeExternalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  }
  catch {
    return null;
  }
}
export function ProjectSearchOption({ projectId, enabled, onChange, query, onQuery }: {
  projectId: string;
  enabled: boolean;
  onChange: (next: boolean) => void;
  query: string;
  onQuery: (next: string) => void;
}) {
  const caps = useQuery({
    queryKey: ['project-ai-tools', projectId], queryFn: () => api.get<'ProjectAiToolsResponse'>(projectPath(projectId, '/ai-tools/capabilities'))
  });
  return <div className="field"><label><input type="checkbox" checked={enabled} disabled={!caps.data?.search.supported} onChange={e => onChange(e.target.checked)}/> 本次允许提供商原生互联网搜索</label><small>{caps.data?.search.reason ?? '正在核对搜索能力'}。费用含模型用量，搜索附加费用待供应商账单核对。</small>{enabled && <label>公开搜索查询<input className="input" required maxLength={500} value={query} onChange={e => onQuery(e.target.value)} placeholder="输入可公开的查询；工具仅执行此查询"/></label>}{caps.error && <ErrorNotice error={caps.error}/>}</div>;
}
export function ProjectToolCalls({ projectId, jobId }: {
  projectId: string;
  jobId: string;
}) {
  const calls = useQuery({
    queryKey: ['project-tool-calls', projectId, jobId], queryFn: () => api.get<'ProjectAiToolCallsResponse'>(projectPath(projectId, '/ai-tools/calls'), {
      jobId
    }), enabled: Boolean(jobId), refetchOnWindowFocus: true
  });
  if (!jobId) {
    return null;
  }
  return <details className="callout"><summary>文件与搜索工具调用记录</summary>{calls.error && <ErrorNotice error={calls.error}/>} {calls.data?.items.length === 0 && <p>本轮尚无工具执行记录。</p>}{calls.data?.items.map(call => <div key={call.id}><p>{call.name === 'list_project_files' ? '列出项目文件' : call.name === 'read_project_file' ? '读取项目文件' : call.name === 'web_search' ? '供应商互联网搜索' : call.name} · {call.status === 'ok' ? '已执行' : '未完成'}{typeof call.result?.error === 'string' ? ` · ${call.result.error}` : ''}</p>{call.result && <ProjectSearchCitations payload={call.result}/>}</div>)}{calls.data?.nextOffset != null && <p>本页展示前20次调用。</p>}<button type="button" className="button button-quiet button-small" onClick={() => void calls.refetch()}>刷新调用记录</button></details>;
}
export function ProjectSearchCitations({ payload }: {
  payload: Record<string, unknown>;
}) {
  const sources = Array.isArray(payload.citations) ? payload.citations : [];
  if (!sources.length) {
    return null;
  }
  return <div className="callout"><strong>供应商返回的搜索来源</strong>{sources.map((item, index) => {
      if (!item || typeof item !== 'object') {
        return null;
      }
      const c = item as Record<string, unknown>, url = typeof c.url === 'string' ? safeExternalUrl(c.url) : null;
      return url ? <p key={index}><a href={url} target="_blank" rel="noreferrer">{typeof c.title === 'string' ? c.title : url}</a></p> : null;
    })}</div>;
}
