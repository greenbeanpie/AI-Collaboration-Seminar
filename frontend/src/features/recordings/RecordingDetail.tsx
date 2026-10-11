import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiUrl, projectPath } from '../../api/client';
import { documentRequest } from '../../pages/document-import-client';
type Session = {
    sessionId: string;
    kind: 'audio' | 'video' | 'photo';
    processingStatus: string;
    summaryMarkdown?: string | null;
    summaryRevision?: number;
    nextCursor?: string | null;
    segments: {
        sequence: number;
        fileId: string;
        startMs: number;
        endMs: number;
        status: string;
        error?: string | null;
    }[];
};
export function RecordingDetail({ projectId, materialId }: {
    projectId: string;
    materialId: string;
}) {
    const [error, setError] = useState('');
    const query = useQuery({ queryKey: ['recordingMaterial', projectId, materialId], queryFn: async () => { const rows = await documentRequest<{
            items: Session[];
        }>(projectPath(projectId, '/recording-sessions'), { query: { materialId } }); if (!rows.items[0])
            return null; const path = projectPath(projectId, `/recording-sessions/${rows.items[0].sessionId}`); const session = await documentRequest<Session>(path); let cursor = session.nextCursor; while (cursor) {
            const page = await documentRequest<Session>(path, { query: { cursor } });
            session.segments.push(...page.segments);
            cursor = page.nextCursor;
        } return session; }, refetchInterval: q => q.state.data && ['pending', 'running'].includes(q.state.data.processingStatus) ? 5000 : false });
    const session = query.data;
    if (!session)
        return query.error ? <p role="alert">录制会话读取失败：{String(query.error)}</p> : null;
    return <section aria-label="会议录制片段"><h3>会议片段与摘要</h3><p>保存状态与处理状态独立。处理：{session.processingStatus} · 摘要版本 {session.summaryRevision ?? 0}</p>{session.summaryMarkdown && <pre style={{ whiteSpace: 'pre-wrap' }}>{session.summaryMarkdown}</pre>}{session.segments.map(s => { const src = apiUrl(projectPath(projectId, `/files/${s.fileId}/content`)); return <article key={s.sequence}><p>第 {s.sequence} 段 · {(s.startMs / 1000).toFixed(1)}–{(s.endMs / 1000).toFixed(1)} 秒 · {s.status}{s.error ? ` · ${s.error}` : ''}</p>{session.kind === 'audio' ? <audio controls preload="none" src={src}/> : session.kind === 'photo' ? <img src={src} alt={`第 ${s.sequence} 张采集照片`} loading="lazy" style={{ maxWidth: '100%' }}/> : <video controls preload="none" playsInline src={src} style={{ maxWidth: '100%', maxHeight: 360 }}/>}</article>; })}<button type="button" className="button button-quiet" onClick={() => { void documentRequest(projectPath(projectId, `/recording-sessions/${session.sessionId}/retry`), { method: 'POST', body: {} }).then(() => query.refetch()).catch(e => setError(String(e))); }}>重试处理</button>{error && <p role="alert">{error}</p>}</section>;
}
