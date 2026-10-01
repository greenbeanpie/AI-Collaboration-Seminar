import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, request } from '../api/client';
import type { DataOf } from '../api/types';
import { useSession } from '../auth';
import { ErrorNotice, PageHeading, Spinner } from '../components/ui';
import { ProfileMarkdown } from '../components/ProfileMarkdown';
import { useSettingsDirty } from './settings-dirty';
import './PersonalProfiles.css';

type Profile = DataOf<'PersonalProfileResponse'>;
type PublicProfile = NonNullable<DataOf<'PublicProfileResponse'>['profile']>;
const names = { bio: '自我介绍', major: '专业', specialties: '特长', preferredRoles: '倾向项目职位' } as const;
const limits = { bio: 4000, major: 160, specialties: 800, preferredRoles: 400 };
function ProfileView({ profile }: { profile: PublicProfile }) {
  return <article className="section-card profile-card"><h2>{profile.displayName}</h2><p>@{profile.username}</p>
    {Object.entries(names).map(([key,label]) => { const value = profile[key as keyof typeof names]; return value !== undefined && <section key={key}><h3>{label}</h3>{key === 'bio' ? <ProfileMarkdown value={value} /> : <p>{value || '暂未填写'}</p>}</section>; })}
  </article>;
}
export function PersonalProfilePage() {
  const session = useSession();
  const [saved,setSaved] = useState<Profile | null>(null);
  const [draft,setDraft] = useState<Profile | null>(null);
  const [error,setError] = useState<unknown>(null); const [notice,setNotice] = useState('');
  const [busy,setBusy] = useState(false); const lock = useRef(false);
  const dirty = JSON.stringify(saved) !== JSON.stringify(draft);
  useSettingsDirty(dirty);
  useEffect(() => { const controller = new AbortController(); api.get<'PersonalProfileResponse'>('/auth/personal-profile',undefined,controller.signal).then(p=>{setSaved(p);setDraft(p);}).catch(e=>{if (!controller.signal.aborted) setError(e);}); return ()=>controller.abort(); }, []);
  async function save(event: FormEvent) {
    event.preventDefault(); if (!draft || lock.current) return;
    lock.current=true;setBusy(true);setError(null);setNotice('');
    try { const { revision,...values }=draft; const p=await request<'PersonalProfileResponse'>('/auth/personal-profile',{method:'PUT',body:{...values,expectedRevision:revision},headers:{'X-Account-Settings':'1'}});setSaved(p);setDraft(p);setNotice('资料与隐私设置已保存'); }
    catch(e) {setError(e);} finally {lock.current=false;setBusy(false);}
  }
  async function reload() { if (dirty && !window.confirm('重新读取将放弃当前未保存修改，是否继续？')) return; setError(null); try {const p=await api.get<'PersonalProfileResponse'>('/auth/personal-profile');setSaved(p);setDraft(p);}catch(e){setError(e);} }
  return <div className="personal-profiles"><PageHeading title="个人资料与隐私" detail="自行决定哪些资料可被其他已登录用户看到。" />
    <p>开启搜索后，其他已登录用户可通过完整用户名找到你，并查看勾选公开的字段。关闭后，搜索与个人主页立即不可用。</p>
    <p>公开展示和 AI 使用分别由你决定。未启用 AI 使用时，你填写的个人资料不会被用于模型请求。</p>
    {error !== null && <ErrorNotice error={error} onRetry={()=>void reload()} />}{notice && <p role="status">{notice}</p>}
    {!draft ? <Spinner /> : <><form onSubmit={save} className="section-card"><fieldset disabled={busy}>
      <label><input type="checkbox" checked={draft.searchable} onChange={e=>setDraft({...draft,searchable:e.target.checked})} />允许通过用户名搜索我</label>
      <p>用户名：@{session.data?.username ?? '此旧账号尚无用户名，暂不可搜索'}</p>
      <section aria-labelledby="profile-ai-consent-title">
        <h2 id="profile-ai-consent-title">AI 任务偏好推荐</h2>
        <p id="profile-ai-consent-description">仅在你勾选并保存后，你在本页填写的自我介绍、专业、特长和倾向职位（包括隐藏字段）才会发送给你所在项目配置的 AI 提供商，用于该项目的任务偏好推荐。项目内有权限的其他成员也可发起推荐；此授权适用于你加入的项目。隐藏字段不会直接展示给组员，推荐理由不会引用资料，不用于成绩、人格或雇佣评价。</p>
        <p>默认关闭。取消勾选并保存可撤回授权，阻止后续请求及旧推荐输出；已发送给提供商的请求无法收回。项目成员资料中的旧专业、技能和每周时间不会自动送给模型。</p>
        <label><input type="checkbox" aria-describedby="profile-ai-consent-description" checked={draft.aiUseAllowed} onChange={e=>setDraft({...draft,aiUseAllowed:e.target.checked})} />我同意将上述个人资料交给项目配置的 AI 提供商用于任务推荐</label>
      </section>
      {Object.entries(names).map(([field,label])=> {const key=field as keyof typeof names;return <section key={key}><label htmlFor={`profile-${key}`}>{label}{key==='bio' ? '（Markdown）' : ''}</label>
        <textarea id={`profile-${key}`} rows={key==='bio' ? 6 : 2} maxLength={limits[key]} value={draft[key]} onChange={e=>setDraft({...draft,[key]:e.target.value})} />
        <label><input type="checkbox" checked={draft.visibility[key]} onChange={e=>setDraft({...draft,visibility:{...draft.visibility,[key]:e.target.checked}})} />公开{label}</label></section>;})}
      <p>Markdown 支持标题、列表、粗体、行内代码和 HTTPS 链接；不执行 HTML，不加载图片。</p>
      <button className="button button-primary" type="submit" disabled={!dirty}>{busy?'保存中…':'保存资料与隐私'}</button>
    </fieldset></form><h2>公开展示预览</h2>{!draft.searchable && <p>当前不允许搜索；以下仅为你自己的预览。</p>}
    <ProfileView profile={{username:session.data?.username ?? '',displayName:session.data?.displayName ?? '',...Object.fromEntries(Object.keys(names).filter(k=>draft.visibility[k as keyof typeof names]).map(k=>[k,draft[k as keyof typeof names]]))}} /></>}
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
