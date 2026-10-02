import { usePageDialogs } from '../dialogs/usePageDialogs';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Pencil } from 'lucide-react';
import { api, request } from '../api/client';
import type { DataOf } from '../api/types';
import { useSession } from '../auth';
import { ErrorNotice, PageHeading, Spinner } from '../components/ui';
import { ProfileMarkdown } from '../components/ProfileMarkdown';
import { useSettingsDirty } from './settings-dirty';
import { accountRequest, type PersonalProfile, type ProfileImportCandidate, type ImportField } from '../api/simplification';
import './PersonalProfiles.css';

type Profile = PersonalProfile;
type PublicProfile = NonNullable<DataOf<'PublicProfileResponse'>['profile']>;
const names = { bio: '自我介绍', major: '专业', specialties: '技能与特长', preferredRoles: '倾向项目职位' } as const;
const limits = { bio: 4000, major: 160, specialties: 800, preferredRoles: 400 };
function ProfileView({ profile }: { profile: PublicProfile }) {
  return <article className="section-card profile-card"><h2>{profile.displayName}</h2><p>@{profile.username}</p>
    {Object.entries(names).map(([key,label]) => { const value = profile[key as keyof typeof names]; return value !== undefined && <section key={key}><h3>{label}</h3>{key === 'bio' ? <ProfileMarkdown value={value} /> : <p>{value || '暂未填写'}</p>}</section>; })}
  </article>;
}
export function PersonalProfilePage() {
  const session = useSession();
  const dialogs = usePageDialogs(session.data?.id);
  const [saved, setSaved] = useState<Profile | null>(null);
  const [draft, setDraft] = useState<Profile | null>(null);
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [candidates, setCandidates] = useState<ProfileImportCandidate[] | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<unknown>(null);
  const [importSelections, setImportSelections] = useState<Record<string, ImportField[]>>({});
  const [imports, setImports] = useState<Array<{ candidateId: string; fields: ImportField[] }>>([]);
  const lock = useRef(false);
  const dirty = JSON.stringify(saved) !== JSON.stringify(draft) || imports.length > 0;
  useSettingsDirty(dirty);

  useEffect(() => {
    const controller = new AbortController();
    api.get<'PersonalProfileResponse'>('/auth/personal-profile', undefined, controller.signal)
      .then(profile => { if (!controller.signal.aborted) { setSaved(profile); setDraft(profile); } })
      .catch(error => { if (!controller.signal.aborted) setError(error); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || !dirty || lock.current) return;
    lock.current = true; setBusy(true); setError(null); setNotice('');
    try {
      const { revision, ...values } = draft;
      const profile = await request<'PersonalProfileResponse'>('/auth/personal-profile', {
        method: 'PUT', body: { ...values, expectedRevision: revision, ...(imports.length ? { legacyImports: imports } : {}) }, headers: { 'X-Account-Settings': '1' },
      });
      setSaved(profile); setDraft(profile); setEditing(false); setNotice('资料与隐私设置已保存');
      setImports([]); setCandidates(null); setImportSelections({});
    } catch (error) { setError(error); }
    finally { lock.current = false; setBusy(false); }
  }

  async function reload() {
    if (lock.current) return;
    lock.current = true;
    try {
      if (dirty && !await dialogs.confirm('重新读取将放弃当前未保存修改，是否继续？')) return;
      setBusy(true); setError(null);
      const profile = await api.get<'PersonalProfileResponse'>('/auth/personal-profile');
      setSaved(profile); setDraft(profile); setEditing(false); setNotice('');
      setImports([]); setCandidates(null); setImportSelections({});
    } catch (error) { setError(error); }
    finally { lock.current = false; setBusy(false); setLoading(false); }
  }

  async function cancelEditing() {
    if (lock.current) return;
    if (dirty && !await dialogs.confirm('有尚未保存的资料编辑。确定放弃这些编辑吗？')) return;
    setDraft(saved); setEditing(false); setError(null); setNotice(''); setImports([]); setImportSelections({});
  }

  async function loadImports() {
    setImportBusy(true); setImportError(null);
    try {
      const items: ProfileImportCandidate[] = []; const seen = new Set<string>(); let cursor: string | null = null;
      do {
        const page: { items: ProfileImportCandidate[]; nextCursor: string | null } = await accountRequest('/auth/personal-profile/import-candidates', { query: { cursor, limit: 100 } });
        items.push(...page.items); cursor = page.nextCursor;
        if (cursor && seen.has(cursor)) throw new Error('导入候选分页异常，请重新读取。');
        if (cursor) seen.add(cursor);
      } while (cursor);
      setCandidates(items);
    } catch (reason) { setImportError(reason); }
    finally { setImportBusy(false); }
  }
  async function importCandidate(candidate: ProfileImportCandidate) {
    const fields = importSelections[candidate.candidateId] ?? [];
    if (!draft || !fields.length) return;
    if (!await dialogs.confirm(`将“${candidate.sourceProjectName}”中所选字段复制到当前草稿？当前字段会被替换，其他草稿编辑保留；保存后才会生效。`)) return;
    const privacyFields = fields.filter((field): field is 'major' | 'specialties' => field === 'major' || field === 'specialties');
    setDraft(current => current ? {
      ...current,
      ...(fields.includes('major') ? { major: candidate.major } : {}),
      ...(fields.includes('specialties') ? { specialties: candidate.skills.join('、') } : {}),
      ...(fields.includes('weeklyAvailableHours') ? { weeklyAvailableHours: candidate.weeklyAvailableHours } : {}),
      visibility: { ...current.visibility, ...Object.fromEntries(privacyFields.map(field => [field, false])) },
      ...(privacyFields.length ? { aiUseAllowed: false } : {}),
    } : current);
    setImports(current => [...current.filter(item => item.candidateId !== candidate.candidateId), { candidateId: candidate.candidateId, fields }]);
    setNotice('已复制到草稿。导入的专业和技能暂不公开，AI 授权已关闭；保存后可重新确认。');
  }

  function viewProfile(profile: Profile, publicOnly = false): PublicProfile {
    return {
      username: session.data?.username ?? '', displayName: session.data?.displayName ?? '',
      ...(!publicOnly || profile.visibility.bio ? { bio: profile.bio } : {}),
      ...(!publicOnly || profile.visibility.major ? { major: profile.major } : {}),
      ...(!publicOnly || profile.visibility.specialties ? { specialties: profile.specialties } : {}),
      ...(!publicOnly || profile.visibility.preferredRoles ? { preferredRoles: profile.preferredRoles } : {}),
    };
  }

  return <div className="personal-profiles">
    <PageHeading title={editing ? '编辑个人资料' : '个人资料'} detail={editing ? '左侧编辑 Markdown 与资料，右侧即时预览；保存后才会生效。' : '你的个人主页。需要修改时，点击右上角的编辑资料。'}
      action={!editing && saved ? <button className="button button-quiet" disabled={busy} onClick={() => { setEditing(true); setError(null); setNotice(''); }}><Pencil size={16}/>编辑资料</button> : undefined}/>
    {error !== null && <ErrorNotice error={error} onRetry={() => void reload()}/>}
    {notice && <p className="notice notice-success" role="status">{notice}</p>}
    {loading && <Spinner/>}
    {saved && !editing && <>
      <section className="profile-privacy-summary" aria-label="已保存的资料隐私设置">
        <p><strong>搜索与公开展示</strong><span>{saved.searchable ? '允许已登录用户通过用户名搜索，并查看勾选公开的字段' : '搜索已关闭，其他用户无法查看个人主页'}</span></p>
        <p><strong>AI 任务推荐</strong><span>{saved.aiUseAllowed ? '已授权项目配置的 AI 提供商使用资料进行任务推荐' : '未授权，个人资料不会用于模型请求'}</span></p>
      </section>
      <section aria-label="我的个人主页"><ProfileView profile={viewProfile(saved)}/></section>
      <section className="section-card"><h3>每周总可用时间</h3><p>{saved.weeklyAvailableHours == null ? '尚未填写' : `${saved.weeklyAvailableHours} 小时`}</p><p className="muted">仅本人可见，不公开，也不发送给 AI。</p></section>
      <p className="muted">以上是仅供你查看的完整资料。其他已登录用户只能看到你勾选公开的字段，且需允许搜索。</p>
    </>}
    {draft && editing && <div className="profile-edit-layout">
      <form className="profile-edit-form" onSubmit={save} aria-label="个人资料编辑">
        <fieldset disabled={busy}>
          <section className="section-card profile-editor-card">
            <h2>Markdown 与个人资料</h2>
            {Object.entries(names).map(([field, label]) => {
              const key = field as keyof typeof names;
              return <section key={key} className="profile-field">
                <label className="field" htmlFor={`profile-${key}`}><span className="field-label">{label}{key === 'bio' ? '（Markdown）' : ''}</span></label>
                <textarea className="input textarea" id={`profile-${key}`} rows={key === 'bio' ? 12 : 2} maxLength={limits[key]} value={draft[key]} onChange={event => setDraft({ ...draft, [key]: event.target.value })}/>
                <label className="profile-toggle"><input type="checkbox" disabled={imports.some(item => item.fields.includes(key as ImportField))} checked={draft.visibility[key]} onChange={event => setDraft({ ...draft, visibility: { ...draft.visibility, [key]: event.target.checked } })}/>公开{label}</label>
              </section>;
            })}
            <p className="muted">Markdown 支持标题、列表、粗体、行内代码和 HTTPS 链接；不执行 HTML，不加载图片。</p>
            <section className="profile-field"><label className="field" htmlFor="profile-weekly-hours"><span className="field-label">每周总可用时间（小时）</span></label><input className="input" id="profile-weekly-hours" type="number" min="0" max="168" step="0.5" value={draft.weeklyAvailableHours ?? ''} onChange={event => setDraft({ ...draft, weeklyAvailableHours: event.target.value === '' ? null : Number(event.target.value) })} /><p className="muted">可留空。仅本人可见，不公开，也不发送给 AI。</p></section>
          </section>
          <section className="section-card profile-imports"><h2>旧项目资料导入</h2><p>候选仅本人可见。逐字段选择复制，保留其他草稿内容；全局资料不会自动被覆盖。</p><button className="button button-quiet" type="button" disabled={importBusy} onClick={() => void loadImports()}>{importBusy ? '读取中…' : '读取导入候选'}</button>{importError !== null && <ErrorNotice error={importError} />}{candidates?.length === 0 && <p>没有待导入的旧项目资料。</p>}{candidates?.filter(candidate => !candidate.importedAt).map(candidate => <article key={candidate.candidateId} className="wizard-task"><h3>{candidate.sourceProjectName}</h3>{(['major', 'specialties', 'weeklyAvailableHours'] as const).map(field => { const value = field === 'major' ? candidate.major : field === 'specialties' ? candidate.skills.join('、') : candidate.weeklyAvailableHours == null ? '未填写' : `${candidate.weeklyAvailableHours} 小时`; return <label className="profile-toggle" key={field}><input type="checkbox" checked={(importSelections[candidate.candidateId] ?? []).includes(field)} onChange={event => setImportSelections(current => ({ ...current, [candidate.candidateId]: event.target.checked ? [...(current[candidate.candidateId] ?? []), field] : (current[candidate.candidateId] ?? []).filter(value => value !== field) }))} />{field === 'weeklyAvailableHours' ? '每周总可用时间' : names[field]}：{value || '未填写'}</label>; })}<button className="button button-quiet" type="button" disabled={!importSelections[candidate.candidateId]?.length} onClick={() => void importCandidate(candidate)}>复制所选字段到草稿</button></article>)}</section>
          <section className="section-card profile-privacy-controls">
            <h2>搜索与隐私</h2>
            <p>用户名：@{session.data?.username ?? '此旧账号尚无用户名，暂不可搜索'}</p>
            <label className="profile-toggle"><input type="checkbox" checked={draft.searchable} onChange={event => setDraft({ ...draft, searchable: event.target.checked })}/>允许通过用户名搜索我</label>
            <p>开启搜索后，其他已登录用户可通过完整用户名找到你，并查看勾选公开的字段。关闭后，搜索与个人主页立即不可用。</p>
            <p>公开展示和 AI 使用分别由你决定。未启用 AI 使用时，你填写的个人资料不会被用于模型请求。</p>
          </section>
          <section className="section-card profile-ai-consent" aria-labelledby="profile-ai-consent-title">
            <h2 id="profile-ai-consent-title">AI 任务偏好推荐</h2>
            <p id="profile-ai-consent-description">仅在你勾选并保存后，你在本页填写的自我介绍、专业、技能与特长和倾向职位（包括隐藏字段）才会发送给你所在项目配置的 AI 提供商，用于该项目的任务偏好推荐。项目内有权限的其他成员也可发起推荐；此授权适用于你加入的项目。隐藏字段不会直接展示给组员，推荐理由不会引用资料，不用于成绩、人格或雇佣评价。每周总可用时间始终不会发送给 AI。</p>
            <p>默认关闭。取消勾选并保存可撤回授权。每次发送前会重新读取并校验授权；已开始发送的请求无法收回，授权变化后会丢弃其推荐结果。项目成员资料中的旧专业、技能和每周时间不会自动送给模型。</p>
            <label className="profile-toggle"><input type="checkbox" disabled={imports.some(item => item.fields.some(field => field === 'major' || field === 'specialties'))} aria-describedby="profile-ai-consent-description" checked={draft.aiUseAllowed} onChange={event => setDraft({ ...draft, aiUseAllowed: event.target.checked })}/>我同意将上述个人资料交给项目配置的 AI 提供商用于任务推荐</label>
          </section>
          <div className="profile-editor-actions">
            <button className="button button-primary" type="submit" disabled={!dirty}>{busy ? '保存中…' : '保存资料与隐私'}</button>
            <button className="button button-quiet" type="button" onClick={cancelEditing}>取消编辑</button>
          </div>
        </fieldset>
      </form>
      <aside className="profile-preview-column" aria-label="个人资料预览">
        <section aria-label="内容预览，仅自己可见"><h2>内容预览</h2><p className="muted">仅自己可见，包含未勾选公开的字段。</p><ProfileView profile={viewProfile(draft)}/></section>
        <section aria-label="公开展示预览"><h2>公开展示预览</h2><p className="muted">草稿预览；保存后才生效。{!draft.searchable && '当前不允许搜索，其他用户无法查看个人主页。'}</p><ProfileView profile={viewProfile(draft, true)}/></section>
      </aside>
    </div>}
  </div>;
}
export function ProfileSearchPage() {
  const [username,setUsername]=useState(''); const [result,setResult]=useState<DataOf<'ProfileSearchResponse'> | null>(null); const [error,setError]=useState<unknown>(null);const [busy,setBusy]=useState(false);const controller=useRef<AbortController | null>(null);
  useEffect(()=>()=>controller.current?.abort(),[]);
  async function search(event:FormEvent) {event.preventDefault();controller.current?.abort();const active=new AbortController();controller.current=active;setError(null);setResult(null);setBusy(true);try{const data=await api.get<'ProfileSearchResponse'>('/profiles/search',{username:username.trim()},active.signal);if(!active.signal.aborted)setResult(data);}catch(e){if(!active.signal.aborted)setError(e);}finally{if(!active.signal.aborted)setBusy(false);}}
  return <div className="personal-profiles"><PageHeading title="查找用户" detail="输入完整用户名；只显示允许被搜索的账号。"/><form onSubmit={search}><label htmlFor="profile-search">用户名</label><input id="profile-search" value={username} minLength={3} maxLength={32} pattern="[A-Za-z0-9_-]+" required onChange={e=>{controller.current?.abort();setBusy(false);setUsername(e.target.value);setResult(null);}} /><button className="button" disabled={busy}>{busy?'查找中…':'查找'}</button></form>{error!==null&&<ErrorNotice error={error}/>}<div role="status">{result?.items.length===0&&'未找到可查看的账号'}{result?.items.map(p=><p key={p.username}><Link to={`/app/people/${encodeURIComponent(p.username)}`}>{p.displayName} · @{p.username}</Link></p>)}</div></div>;
}
export function PublicProfilePage() {
  const {username}=useParams(); const [profile,setProfile]=useState<PublicProfile | null>(null);const [error,setError]=useState<unknown>(null);const [loading,setLoading]=useState(true);
  useEffect(()=>{const controller=new AbortController();setLoading(true);setProfile(null);setError(null);api.get<'PublicProfileResponse'>(`/profiles/${encodeURIComponent(username ?? '')}`,undefined,controller.signal).then(r=>{if(!controller.signal.aborted)setProfile(r.profile);}).catch(e=>{if(!controller.signal.aborted)setError(e);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});return()=>controller.abort();},[username]);
  return <div className="personal-profiles"><PageHeading title="个人资料"/>{loading?<Spinner/>:error!==null?<ErrorNotice error={error}/>:profile?<ProfileView profile={profile}/>:<p>未找到可查看的账号</p>}</div>;
}
