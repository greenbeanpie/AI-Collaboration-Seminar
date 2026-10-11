export type RecordingKind = 'audio' | 'video' | 'photo';
export type RecordingSegment = {
    sequence: number;
    name: string;
    sizeBytes: number;
    startMs: number;
    endMs: number;
    sha256: string;
    fileId?: string;
};
export type RecordingDraft = {
    id: string;
    accountId: string;
    projectId: string;
    kind: RecordingKind;
    state: 'recording' | 'paused' | 'stopped' | 'interrupted' | 'uploading' | 'uploaded';
    createdAt: string;
    elapsedMs: number;
    segments: RecordingSegment[];
    interruptions: {
        startMs: number;
        endMs: number;
        reason: string;
    }[];
    error?: string;
    sessionId?: string;
    tailType?: string;
    incompleteFiles?: string[];
};
let database: Promise<IDBDatabase> | undefined;
function db() { return database ??= new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('buwei-recordings', 2); r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('drafts'))
    r.result.createObjectStore('drafts', { keyPath: 'id' }); if (!r.result.objectStoreNames.contains('segments'))
    r.result.createObjectStore('segments'); if (!r.result.objectStoreNames.contains('tails'))
    r.result.createObjectStore('tails'); }; r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); }
async function transaction<T>(stores: string[], mode: IDBTransactionMode, run: (tx: IDBTransaction) => IDBRequest<T>): Promise<T> { const tx = (await db()).transaction(stores, mode); return new Promise((resolve, reject) => { const r = run(tx); tx.oncomplete = () => resolve(r.result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error ?? new Error('本机保存失败')); }); }
export function saveDraft(draft: RecordingDraft) { return transaction(['drafts'], 'readwrite', tx => tx.objectStore('drafts').put(draft)); }
export async function saveSegment(draft: RecordingDraft, blob: Blob, tailThrough?: number) { const payload = { bytes: await blob.arrayBuffer(), type: blob.type }; return transaction(['drafts', 'segments', 'tails'], 'readwrite', tx => { tx.objectStore('segments').put(payload, `${draft.id}:${draft.segments.at(-1)!.sequence}`); if (tailThrough !== undefined)
    tx.objectStore('tails').delete(IDBKeyRange.bound([draft.id, 0], [draft.id, tailThrough])); return tx.objectStore('drafts').put(draft); }); }
export async function appendTail(draft: RecordingDraft, index: number, blob: Blob) { const payload = { bytes: await blob.arrayBuffer(), type: blob.type }; return transaction(['drafts', 'tails'], 'readwrite', tx => { tx.objectStore('tails').put(payload, [draft.id, index]); return tx.objectStore('drafts').put(draft); }); }
export async function readTail(draft: RecordingDraft) { const rows = await transaction<{
    bytes: ArrayBuffer;
    type: string;
}[]>(['tails'], 'readonly', tx => tx.objectStore('tails').getAll(IDBKeyRange.bound([draft.id, 0], [draft.id, Number.MAX_SAFE_INTEGER]))); if (!rows.length)
    return null; return new Blob(rows.map(r => r.bytes), { type: rows[0].type }); }
export async function recoverDraft(draft: RecordingDraft) { if (!['recording', 'paused', 'interrupted'].includes(draft.state))
    return draft; const tail = await readTail(draft); draft.state = 'interrupted'; draft.error = '录制意外中断，已完成片段保留'; if (tail && draft.kind === 'audio') {
    const samples = new Float32Array(await tail.arrayBuffer()), blob = wav(samples);
    const start = draft.segments.at(-1)?.endMs ?? 0;
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))).map(b => b.toString(16).padStart(2, '0')).join('');
    draft.segments.push({ sequence: draft.segments.length + 1, name: `audio-recovered-${draft.segments.length + 1}.wav`, sizeBytes: blob.size, startMs: start, endMs: start + samples.length / 16, sha256 });
    await saveSegment(draft, blob, Number.MAX_SAFE_INTEGER);
}
else if (tail) {
    draft.tailType = tail.type;
    draft.error += '；视频尾段可能损坏，仅供导出检查';
} await saveDraft(draft); return draft; }
export async function listDrafts(accountId: string, projectId: string) { return (await transaction<RecordingDraft[]>(['drafts'], 'readonly', tx => tx.objectStore('drafts').getAll())).filter(d => d.accountId === accountId && d.projectId === projectId); }
export async function readSegment(draft: RecordingDraft, sequence: number): Promise<Blob> { const blob = await transaction<{
    bytes: ArrayBuffer;
    type: string;
} | undefined>(['segments'], 'readonly', tx => tx.objectStore('segments').get(`${draft.id}:${sequence}`)); if (!blob)
    throw new Error('片段本机文件缺失'); return new Blob([blob.bytes], { type: blob.type }); }
export async function removeDraft(draft: RecordingDraft) { return transaction(['drafts', 'segments', 'tails'], 'readwrite', tx => { draft.segments.forEach(s => tx.objectStore('segments').delete(`${draft.id}:${s.sequence}`)); tx.objectStore('tails').delete(IDBKeyRange.bound([draft.id, 0], [draft.id, Number.MAX_SAFE_INTEGER])); return tx.objectStore('drafts').delete(draft.id); }); }
export function wav(samples: Float32Array): Blob { const bytes = new ArrayBuffer(44 + samples.length * 2); const v = new DataView(bytes); const str = (at: number, s: string) => { for (let i = 0; i < s.length; i++)
    v.setUint8(at + i, s.charCodeAt(i)); }; str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE'); str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, samples.length * 2, true); samples.forEach((s, i) => v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * (s < 0 ? 32768 : 32767), true)); return new Blob([bytes], { type: 'audio/wav' }); }
