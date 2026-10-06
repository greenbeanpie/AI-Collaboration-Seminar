import { FileContributorPicker } from '../../components/FileContributors';
import { FilePlus2, FileText, Globe2, LoaderCircle, Send, Type } from 'lucide-react';
import { ErrorNotice, Field, SectionCard } from '../../components/ui';
import type { useSourcesController } from './useSourcesController';
import { formatBytes } from './format';

export function SourceIntake({ model }: { model: ReturnType<typeof useSourcesController> }) {
  const { projectId, capability, kind, setKind, title, setTitle, text, setText, url, setUrl, file, setFile, parseMode, setParseMode, importAbort, contributorIds, setContributorIds, pendingUpload, setPendingUpload, submitting, submitStage, actionError, successMessage, fileInitIntentKeys, submitSource } = model;
  if (!capability) return null;
  const canSubmit = !submitting && (kind !== 'web' || capability.features.webFetch);
  return <SectionCard title="导入资料" detail="支持粘贴原文、公开网页链接，以及 PDF/DOCX/TXT/Markdown 和音视频文件。">
      <form className="sources-intake" onSubmit={(event) => void submitSource(event)}>
        <div className="sources-intake-tabs" role="group" aria-label="来源类型">
          <button type="button" className="sources-intake-tab" aria-pressed={kind === 'paste'} onClick={() => setKind('paste')}><Type size={15} /> 粘贴文本</button>
          <button type="button" className="sources-intake-tab" aria-pressed={kind === 'web'} disabled={!capability.features.webFetch} onClick={() => setKind('web')}><Globe2 size={15} /> 网页链接</button>
          <button type="button" className="sources-intake-tab" aria-pressed={kind === 'file'} onClick={() => setKind('file')}><FileText size={15} /> 文件</button>
        </div>
        {!capability.features.webFetch ? <div className="callout warning-callout">网页读取当前不可用。请粘贴可核对的原文，或上传 PDF/TXT/Markdown 文件。</div> : null}
        {kind === 'paste' && <Field aiReference label="通知或项目资料原文" hint="内容会作为来源版本保存。不要添加未经原文支持的日期、权重或要求。"><textarea className="input textarea" rows={7} maxLength={100_000} value={text} onChange={(event) => setText(event.target.value)} placeholder="粘贴通知原文或公开项目资料…" /></Field>}
        {kind === 'web' && <>
          {!capability.features.webFetch && <div className="callout warning-callout">当前服务能力未启用网页读取。你仍可粘贴网页原文或上传文件。</div>}
          <Field aiReference label="公开网页地址" hint="网页是否可读取取决于后端网络与域名规则；失败时会显示服务端原因。"><input className="input" type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.org/notice" disabled={!capability.features.webFetch} /></Field>
        </>}
        {kind === 'file' && <>
          <Field aiReference label="选择来源文件" hint="支持 PDF、DOCX、TXT、Markdown、MP3、WAV、M4A、MP4、WebM，没有应用层文件大小或文档页数上限。大文档建议本机解析，实际受设备和平台能力限制；音视频原文件由独立 Gemini 模型生成摘要，仍受供应商能力限制。">
            <input className="input" type="file" accept=".pdf,.docx,.txt,.md,.mp3,.wav,.m4a,.mp4,.webm,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown,audio/mpeg,audio/wav,audio/mp4,video/mp4,video/webm" onChange={(event) => { setFile(event.target.files?.[0] ?? null); setPendingUpload(null); }} />
          </Field>
          <FileContributorPicker projectId={projectId} value={contributorIds} onChange={ids => { setContributorIds(ids); if (file) fileInitIntentKeys.current.delete(file); }} disabled={submitting || Boolean(pendingUpload)} />
          {file && <div className="callout">已选择 {file.name} · {formatBytes(file.size)}{pendingUpload?.file === file ? ' · 文件内容已上传，重试时会复用上传记录' : ''}</div>}
        </>}
        <Field aiReference label="来源标题（可选）"><input className="input" value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} placeholder={kind === 'file' ? file?.name ?? '使用文件名' : kind === 'web' ? '使用网页标题' : '粘贴文本'} /></Field>
        {actionError ? <ErrorNotice error={actionError} /> : null}
        {successMessage && <div className="notice notice-success" role="status"><FilePlus2 size={17} /><div className="notice-copy"><strong>{successMessage}</strong></div></div>}
        {kind === 'file' && (!file || /\.(pdf|docx)$/i.test(file.name)) && <Field label="正文解析方式"><select className="input" value={parseMode} onChange={e=>setParseMode(e.target.value as typeof parseMode)}><option value="auto">自动建议：小 PDF 云端，大 PDF 本机；DOCX 本机</option><option value="cloud">云端读取文字型 PDF</option><option value="browser">本机读取 PDF / DOCX</option></select><p className="form-note">10 MiB / 30 页是建议切换阈值，不是导入上限。未读取的图片、公式等会明确提示。</p></Field>}
        {submitting && importAbort.current && <button type="button" className="button button-quiet" onClick={()=>importAbort.current?.abort()}>停止本机解析</button>}
        <div className="form-actions"><button className="button button-primary" type="submit" disabled={!canSubmit || (kind === 'file' && (!file || contributorIds?.length === 0))}>{submitting ? <><LoaderCircle className="spin" size={15} /> {submitStage || '正在提交'}</> : <><Send size={15} /> {capability.features.aiEnabled ? '导入并开始解析' : '导入来源'}</>}</button><span className="sources-inline-note">按服务端单页上限分批读取完整来源列表。</span></div>
      </form>
    </SectionCard>;
}
