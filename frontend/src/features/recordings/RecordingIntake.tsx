import { confirmPage } from '../../dialogs/dialog-service';
import './recordings.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FileContributorPicker } from '../../components/FileContributors';
import { offlineAccount } from '../../offline/store';
import { desktopInvoke, isDesktop } from '../../desktop/bridge';
import { setDesktopDirty } from '../../desktop/lifecycle';
import { documentRequest } from '../../pages/document-import-client';
import { uploadProjectFile } from '../../pages/source-workflows';
import { projectPath } from '../../api/client';
import { BrowserCapture } from './capture';
import { listDrafts, readSegment, readTail, recoverDraft, removeDraft, saveDraft, type RecordingDraft, type RecordingKind } from './store';
type Capabilities = {
    audio: boolean;
    video: boolean;
    photo: boolean;
    background: boolean;
    reason?: string;
    devices: {
        id: string;
        label: string;
        kind: string;
    }[];
};
export function RecordingIntake({ projectId, onActivityChange }: {
    projectId: string;
    onActivityChange?: (active: boolean) => void;
}) {
    const client = useQueryClient(), capture = useRef<BrowserCapture | null>(null), preview = useRef<HTMLVideoElement>(null), busyLock = useRef(false);
    const [drafts, setDrafts] = useState<RecordingDraft[]>([]), [current, setCurrent] = useState<RecordingDraft | null>(null), [caps, setCaps] = useState<Capabilities | null>(null), [kind, setKind] = useState<RecordingKind>('audio'), [audio, setAudio] = useState(''), [camera, setCamera] = useState(''), [title, setTitle] = useState(''), [contributors, setContributors] = useState<string[] | undefined>(), [error, setError] = useState(''), [busy, setBusy] = useState(false), [media, setMedia] = useState('');
    const native = isDesktop(), account = offlineAccount()?.id;
    const refresh = useCallback(async (recover = false) => { if (!account)
        return; const rows = native ? await desktopInvoke<RecordingDraft[]>('recording_list', { projectId }) : await listDrafts(account, projectId); const owned = rows.filter(d => d.accountId === account); setDrafts(recover && !native ? await Promise.all(owned.map(recoverDraft)) : owned); if (native)
        setCurrent(previous => rows.find(d => d.id === previous?.id) ?? previous); }, [account, native, projectId]);
    async function run(action: () => Promise<void>) { if (busyLock.current)
        return; busyLock.current = true; setBusy(true); setError(''); try {
        await action();
    }
    catch (e) {
        setError(e instanceof Error ? e.message : String(e));
    }
    finally {
        busyLock.current = false;
        setBusy(false);
    } }
    useEffect(() => { let cancelled = false; const initialize = async () => { try {
        await refresh(true);
        const capability = native ? await desktopInvoke<Capabilities>('recording_capabilities', { projectId }) : { audio: Boolean(navigator.mediaDevices && typeof AudioWorkletNode !== 'undefined'), video: Boolean(navigator.mediaDevices && typeof MediaRecorder !== 'undefined'), photo: Boolean(navigator.mediaDevices?.getUserMedia), background: false, devices: (await navigator.mediaDevices?.enumerateDevices() ?? []).map(d => ({ id: d.deviceId, label: d.label || d.kind, kind: d.kind })) };
        if (!cancelled)
            setCaps(capability);
    }
    catch (e) {
        if (!cancelled)
            setError(String(e));
    } }; void initialize(); const hidden = () => { if (!native && document.hidden && capture.current)
        void capture.current.stop('网页切入后台，录制已停止'); }; const leaving = (e: BeforeUnloadEvent) => { if (capture.current?.draft.state === 'recording') {
        e.preventDefault();
        void capture.current.stop('离开页面');
    } }; document.addEventListener('visibilitychange', hidden); window.addEventListener('beforeunload', leaving); return () => { cancelled = true; document.removeEventListener('visibilitychange', hidden); window.removeEventListener('beforeunload', leaving); if (!native)
        void capture.current?.stop('离开录制页'); setDesktopDirty('recording', false); }; }, [projectId, account, native, refresh]);
    useEffect(() => { if (!native)
        return; const timer = setInterval(() => { void refresh().catch(e => setError(String(e))); }, 2000); return () => clearInterval(timer); }, [native, projectId, account, refresh]);
    useEffect(() => { if (media.startsWith('blob:'))
        return () => URL.revokeObjectURL(media); }, [media]);
    async function start() { if (!account)
        throw new Error('请先登录'); if (!caps?.[kind])
        throw new Error(caps?.reason || '当前设备不支持该采集方式'); if (current && ['recording', 'paused'].includes(current.state))
        throw new Error('请先停止当前录制'); setMedia(''); if (native) {
        setCurrent(await desktopInvoke<RecordingDraft>('recording_start', { projectId, kind, inputDeviceId: audio || null, cameraDeviceId: camera || null }));
        return;
    } const draft: RecordingDraft = { id: crypto.randomUUID(), accountId: account, projectId, kind, state: 'recording', createdAt: new Date().toISOString(), elapsedMs: 0, segments: [], interruptions: [] }; const engine = new BrowserCapture(draft, d => { setCurrent(d); if (offlineAccount()?.id !== d.accountId && d.state === 'recording')
        void capture.current?.stop('账号发生变化'); setDesktopDirty('recording', d.state === 'recording' || d.state === 'paused'); }); capture.current = engine; await engine.start(audio, camera); setCurrent(draft); if (preview.current)
        preview.current.srcObject = engine.stream!; }
    async function action(action: 'pause' | 'resume' | 'stop' | 'photo') { if (!current)
        return; if (native)
        setCurrent(await desktopInvoke<RecordingDraft>('recording_action', { projectId, id: current.id, action, ...(action === 'resume' ? { inputDeviceId: audio, cameraDeviceId: camera } : {}) }));
    else {
        if (action === 'resume') {
            await capture.current?.resume(audio, camera);
            if (preview.current && capture.current?.stream)
                preview.current.srcObject = capture.current.stream;
        }
        else
            await capture.current?.[action]();
        await refresh();
    } }
    async function view(draft: RecordingDraft, sequence: number) { setCurrent(draft); if (native) {
        const result = await desktopInvoke<{
            mime: string;
            dataUrl: string;
        }>('recording_preview', { projectId, id: draft.id, sequence });
        const encoded=result.dataUrl.split(',')[1];
        if (!encoded || !result.dataUrl.startsWith(`data:${result.mime};base64,`)) throw new Error('原生预览数据无效');
        const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));
        setMedia(URL.createObjectURL(new Blob([bytes],{type:result.mime})));
    }
    else
        setMedia(URL.createObjectURL(await readSegment(draft, sequence))); }
    async function upload(draft: RecordingDraft) { if (account !== draft.accountId || offlineAccount()?.id !== draft.accountId)
        throw new Error('账号发生变化，请重新打开本账号草稿'); if (!draft.segments.length)
        throw new Error('没有已保存片段'); if (['recording', 'paused'].includes(draft.state))
        throw new Error('请先停止录制再确认上传'); const path = projectPath(projectId, '/recording-sessions'); const session = await documentRequest<{
        sessionId: string;
    }>(path, { method: 'POST', body: { clientSessionId: draft.id, title: title.trim() || `采集资料 ${draft.createdAt}`, kind: draft.kind, contributorIds: contributors } }); draft.sessionId = session.sessionId; if (!native)
        await saveDraft(draft); if (native)
        draft = await desktopInvoke<RecordingDraft>('recording_upload', { projectId, id: draft.id, sessionId: session.sessionId, contributorIds: contributors ?? null }); for (const segment of draft.segments) {
        if (offlineAccount()?.id !== draft.accountId)
            throw new Error('账号发生变化，已停止上传');
        if (!segment.fileId) {
            const blob = await readSegment(draft, segment.sequence);
            segment.fileId = await uploadProjectFile(projectId, new File([blob], segment.name, { type: blob.type }), `${draft.id}-${segment.sequence}`, undefined, { contributorIds: contributors });
            await saveDraft(draft);
        }
        await documentRequest(`${path}/${session.sessionId}/segments/${segment.sequence}`, { method: 'PUT', body: { fileId: segment.fileId, startMs: segment.startMs, endMs: segment.endMs, sha256: segment.sha256 } });
    } await documentRequest(`${path}/${session.sessionId}/complete`, { method: 'POST', body: { segmentCount: draft.segments.length, interruptions: draft.interruptions } }); if (!native) {
        draft.state = 'uploaded';
        await saveDraft(draft);
    } setCurrent({ ...draft }); await refresh(); await client.invalidateQueries({ queryKey: ['materials', projectId] }); await client.invalidateQueries({ queryKey: ['sources', projectId] }); await client.invalidateQueries({ queryKey: ['resource-library', projectId] }); await client.invalidateQueries({ queryKey: ['recordingMaterial', projectId] }); }
    const active = current && ['recording', 'paused'].includes(current.state);
    const activity = busy || Boolean(active);
    useEffect(() => { onActivityChange?.(activity); }, [activity, onActivityChange]);
    return <section className="callout recording-intake" aria-label="直接采集资料"><h3>录音 / 录像 / 拍照</h3><p>先保存在本机，预览后确认上传。{native ? '客户端后台采集能力以当前设备结果为准。' : '网页只支持前台录制，切入后台会停止并保存。'}本机副本需手动清理。</p>{caps?.reason &&
      <p>{caps.reason}</p>}<div className="form-actions"><label>采集方式<select className="input" value={kind} disabled={Boolean(active)} onChange={e => setKind(e.target.value as RecordingKind)}>
      <option value="audio">录音</option><option value="video">录像</option><option value="photo">拍照</option>
      </select></label><label>麦克风<select className="input" value={audio} disabled={current?.state === 'recording'} onChange={e => setAudio(e.target.value)}>
      <option value="">默认设备</option>{caps?.devices.filter(d => d.kind === 'audioinput').map(d => <option key={d.id} value={d.id}>{d.label}</option>)}</select>
      </label><label>摄像头<select className="input" value={camera} disabled={current?.state === 'recording'} onChange={e => setCamera(e.target.value)}>
      <option value="">默认摄像头</option>{caps?.devices.filter(d => d.kind === 'videoinput').map(d => <option key={d.id} value={d.id}>{d.label}</option>)}</select>
      </label><button className="button button-quiet" type="button" disabled={busy || Boolean(active) ||
      !caps?.[kind]} onClick={() => void run(start)}>{native && kind === 'photo' ? '拍照 / 重拍' : '开始 / 重录'}</button>{active &&
      <><button className="button button-quiet" type="button" disabled={busy || current.kind === 'photo'} onClick={() => void run(() => action(current.state === 'paused' ? 'resume' : 'pause'))}>{current.state === 'paused' ? '继续' : '暂停'}</button>
      <button className="button button-quiet" type="button" disabled={busy} onClick={() => void run(() => action(current.kind === 'photo' &&
      !native ? 'photo' : 'stop'))}>{current.kind === 'photo' && !native ? '拍下照片' : '停止并保存'}</button>
      </>}</div><video ref={preview} autoPlay muted playsInline hidden={native || !active || kind === 'audio'} style={{ maxWidth: '100%',
      maxHeight: 300 }}/>{current && <p role="status">{({ recording: '录制中', paused: '已暂停', stopped: '已保存',
      interrupted: '意外中断，文件已保留', uploading: '上传中', uploaded: '已上传' })[current.state]} · {(current.elapsedMs / 1000).toFixed(0)} 秒 · 已保存 {current.segments.length} 段 · {(current.segments.reduce((n,
      s) => n + s.sizeBytes, 0) / 1048576).toFixed(1)} MiB{current.error ? ` · ${current.error}` : ''}</p>}{media &&
      (current?.kind === 'photo' ? <img src={media} alt="采集照片预览" style={{ maxWidth: '100%' }}/> : current?.kind === 'audio' ? <audio src={media} controls/> : <video src={media} controls playsInline style={{ maxWidth: '100%' }}/>)}<label>会议 / 资料标题<input className="input" maxLength={200} value={title} onChange={e => setTitle(e.target.value)}/>
      </label><FileContributorPicker projectId={projectId} value={contributors} onChange={setContributors} disabled={busy}/>{error &&
      <p role="alert">{error}</p>}{drafts.map(d => <article key={d.id}><p>{d.kind} · {d.createdAt} · {d.segments.length} 段{d.error ? ' · ' + d.error : ''}{d.state === 'uploaded' ? ' · 已上传，副本保留' : ''}{['recording',
      'paused'].includes(d.state) && d.id !== current?.id ? ' · 意外中断，可恢复已完成片段' : ''}</p><div className="form-actions">{d.segments.map(s => <button className="button button-quiet" type="button" disabled={busy} key={s.sequence} onClick={() => void run(() => view(d,
      s.sequence))}>预览第 {s.sequence} 段</button>)}<button className="button button-primary" type="button" disabled={busy ||
      !d.segments.length || Boolean(active)} onClick={() => void run(() => upload({ ...d, state: d.state === 'recording' ||
      d.state === 'paused' ? 'interrupted' : d.state }))}>确认上传 / 重试</button><button className="button button-quiet" type="button" disabled={busy} onClick={() => void run(async () => { if (native) {
        for (const s of d.segments)
            await desktopInvoke('recording_export', { projectId, id: d.id, sequence: s.sequence });
    }
    else
        for (const s of d.segments) {
            const url = URL.createObjectURL(await readSegment(d, s.sequence));
            const a = document.createElement('a');
            a.href = url;
            a.download = s.name;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        } })}>导出</button>{d.incompleteFiles?.map(name => <button className="button button-quiet" type="button" key={name} onClick={() => void run(async () => { await desktopInvoke('recording_export_tail', { projectId, id: d.id, name }); })}>导出可能损坏的尾段 {name}</button>)}{d.tailType && <button type="button" className="button button-quiet" onClick={() => void run(async () => { const tail = await readTail(d); if (!tail)
        return; const url = URL.createObjectURL(tail); const a = document.createElement('a'); a.href = url; a.download = 'interrupted-tail.webm'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); })}>导出可能损坏的尾段</button>}<button className="button button-quiet" type="button" disabled={busy || Boolean(active)} onClick={() => void run(async () => { if (!await confirmPage('确认删除本机副本？未上传文件删除后不可恢复。'))
        return; if (native)
        await desktopInvoke('recording_remove', { projectId, id: d.id });
    else
        await removeDraft(d); await refresh(); })}>清理本机副本</button></div></article>)}</section>;
}
