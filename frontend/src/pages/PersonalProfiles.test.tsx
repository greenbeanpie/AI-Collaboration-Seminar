import { cancelPageDialog } from '../dialogs/dialog-service';
import { cleanup,fireEvent,render,screen,waitFor,within,act } from '@testing-library/react';
import { QueryClient,QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter,Routes,Route,createMemoryRouter,RouterProvider,NavLink } from 'react-router-dom';
import { SettingsEditGuard } from './SettingsEditGuard';
import { afterEach,it,expect,vi } from 'vitest';
import { PersonalProfilePage,ProfileSearchPage,PublicProfilePage } from './PersonalProfiles';
import { SettingsDirtyContext } from './settings-dirty';
const user={id:'fixture',username:'alice',displayName:'Alice',email:null,isAdmin:false,role:'user'};
const profile={revision:0,searchable:false,aiUseAllowed:false,bio:'',major:'',specialties:'',preferredRoles:'',visibility:{bio:false,major:false,specialties:false,preferredRoles:false}};
const response=(data:unknown)=>Response.json({data,requestId:'test'});
it('marks only AI-authorized profile content and excludes private weekly availability',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>response({...profile,aiUseAllowed:true,weeklyAvailableHours:7,major:'计算机'})));
 setup(); await screen.findByRole('button',{name:'编辑资料'});
 const homepage=screen.getByRole('region',{name:'我的个人主页'});
 expect(homepage.querySelectorAll('[data-ai-reference-badge]')).toHaveLength(4);
 expect(screen.getByText('每周总可用时间').parentElement?.querySelector('[data-ai-reference-badge]')).toBeNull();
});
it('does not mark unauthorized profile content as available to AI',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>response({...profile,major:'私密专业'})));
 setup(); await screen.findByRole('button',{name:'编辑资料'});
 expect(screen.getByRole('region',{name:'我的个人主页'}).querySelector('[data-ai-reference-badge]')).toBeNull();
});
afterEach(async()=>{await act(async()=>{cancelPageDialog();});cleanup();vi.unstubAllGlobals();});
async function answer(name: '确定' | '取消') { const dialog=await screen.findByRole('dialog'); await act(async()=>{fireEvent.click(within(dialog).getByRole('button', { name }));}); await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); }
function setup(path='/app/profile',dirty=vi.fn()) {const client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity}}});client.setQueryData(['session'],user);render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><SettingsDirtyContext.Provider value={dirty}><Routes><Route path="/app/profile" element={<PersonalProfilePage/>}/><Route path="/app/people" element={<ProfileSearchPage/>}/><Route path="/app/people/:username" element={<PublicProfilePage/>}/></Routes></SettingsDirtyContext.Provider></MemoryRouter></QueryClientProvider>);return dirty;}
it('keeps private edits out of public preview, saves visibility with revision and dirty guard',async()=>{
 let saved:unknown;vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{if(init?.method==='PUT'){saved=JSON.parse(init.body);return response({...profile,...saved as object,revision:1});}return response(profile);}));const dirty=setup();
 fireEvent.click(await screen.findByRole('button',{name:'编辑资料'}));const major=screen.getByLabelText('专业');fireEvent.change(major,{target:{value:'PRIVATE FIELD'}});expect(within(screen.getByRole('region',{name:'公开展示预览'})).queryByText('PRIVATE FIELD',{selector:'p'})).toBeNull();expect(within(screen.getByRole('region',{name:'内容预览，仅自己可见'})).getByText('PRIVATE FIELD',{selector:'p'})).toBeInTheDocument();expect(dirty).toHaveBeenLastCalledWith(expect.any(String),true);
 fireEvent.click(screen.getByLabelText('公开专业'));expect(within(screen.getByRole('region',{name:'公开展示预览'})).getByText('PRIVATE FIELD',{selector:'p'})).toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'保存资料与隐私'}));await screen.findByText('资料与隐私设置已保存');expect(saved).toMatchObject({expectedRevision:0,major:'PRIVATE FIELD',visibility:{major:true},searchable:false});await waitFor(()=>expect(dirty).toHaveBeenLastCalledWith(expect.any(String),false));
});
it('retains edits on version conflict without silently overwriting',async()=>{vi.stubGlobal('fetch',vi.fn(async(_url,init)=>init?.method==='PUT'?Response.json({error:{code:'VERSION_CONFLICT',message:'资料已更新',retryable:false},requestId:'test'},{status:409}):response(profile)));setup();fireEvent.click(await screen.findByRole('button',{name:'编辑资料'}));fireEvent.change(screen.getByLabelText('专业'),{target:{value:'My edit'}});fireEvent.click(screen.getByRole('button',{name:'保存资料与隐私'}));await screen.findByText(/资料已更新/);expect(screen.getByLabelText('专业')).toHaveValue('My edit');});
it('search uses full username only and links to the public page',async()=>{const fetch=vi.fn(async(url: string)=>{expect(url).toContain('username=alice');return response({items:[{username:'alice',displayName:'Alice'}],nextCursor:null});});vi.stubGlobal('fetch',fetch);setup('/app/people');expect(fetch).not.toHaveBeenCalled();fireEvent.change(screen.getByLabelText('用户名'),{target:{value:'alice'}});fireEvent.click(screen.getByRole('button',{name:'查找'}));expect(await screen.findByRole('link')).toHaveAttribute('href','/app/people/alice');expect(fetch.mock.calls[0]?.[0]).toContain('username=alice');});
it('unavailable public profile has no identity or hidden fields',async()=>{vi.stubGlobal('fetch',vi.fn(async()=>response({profile:null})));setup('/app/people/alice');await waitFor(()=>expect(screen.getByText('未找到可查看的账号')).toBeInTheDocument());expect(screen.queryByText('Alice')).toBeNull();});
it('requires an independent informed AI opt-in and preserves explicit withdrawal',async()=>{
 const writes:Record<string,unknown>[]=[];let current=profile;
 vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{if(init?.method==='PUT'){const body=JSON.parse(init.body);writes.push(body);current={...current,...body,revision:current.revision+1};}return response(current);}));setup();
 fireEvent.click(await screen.findByRole('button',{name:'编辑资料'}));let consent=screen.getByLabelText('我同意将上述个人资料交给项目配置的 AI 提供商用于任务推荐');expect(consent).not.toBeChecked();expect(screen.getByText(/仅在你勾选并保存后/)).toHaveTextContent('项目配置的 AI 提供商');
 fireEvent.change(screen.getByLabelText('专业'),{target:{value:'PRIVATE'}});fireEvent.click(screen.getByLabelText('允许通过用户名搜索我'));fireEvent.click(screen.getByLabelText('公开专业'));expect(consent).not.toBeChecked();
 fireEvent.click(screen.getByRole('button',{name:'保存资料与隐私'}));await screen.findByText('资料与隐私设置已保存');expect(writes[0]).toMatchObject({aiUseAllowed:false,searchable:true});
 fireEvent.click(await screen.findByRole('button',{name:'编辑资料'}));consent=screen.getByLabelText('我同意将上述个人资料交给项目配置的 AI 提供商用于任务推荐');fireEvent.click(consent);fireEvent.click(screen.getByRole('button',{name:'保存资料与隐私'}));await waitFor(()=>expect(writes).toHaveLength(2));expect(writes[1]).toMatchObject({aiUseAllowed:true,expectedRevision:1});
 fireEvent.click(await screen.findByRole('button',{name:'编辑资料'}));consent=screen.getByLabelText('我同意将上述个人资料交给项目配置的 AI 提供商用于任务推荐');expect(consent).toBeChecked();fireEvent.click(consent);fireEvent.click(screen.getByRole('button',{name:'保存资料与隐私'}));await waitFor(()=>expect(writes).toHaveLength(3));expect(writes[2]).toMatchObject({aiUseAllowed:false,expectedRevision:2,searchable:true});
});

it('opens the saved personal homepage in read mode and enters an explicit live Markdown editor', async () => {
 vi.stubGlobal('fetch', vi.fn(async () => response({ ...profile, bio: '# My homepage', major: 'Private major' })));
 setup();
 await screen.findByRole('button', { name: '编辑资料' });
 expect(screen.queryByRole('textbox')).toBeNull();
 expect(within(screen.getByRole('region', { name: '我的个人主页' })).getByRole('heading', { name: 'My homepage' })).toBeInTheDocument();
 expect(screen.getByText('Private major')).toBeInTheDocument();
 fireEvent.click(screen.getByRole('button', { name: '编辑资料' }));
 fireEvent.change(screen.getByLabelText('自我介绍（Markdown）'), { target: { value: '# New draft' } });
 expect(within(screen.getByRole('region', { name: '内容预览，仅自己可见' })).getByRole('heading', { name: 'New draft' })).toBeInTheDocument();
 expect(within(screen.getByRole('region', { name: '公开展示预览' })).queryByRole('heading', { name: 'New draft' })).toBeNull();
});
it('canceling dirty edits requires confirmation and never saves a discarded draft', async () => {
 const fetch = vi.fn(async () => response({ ...profile, major: 'Saved major' })); vi.stubGlobal('fetch', fetch);
 setup(); fireEvent.click(await screen.findByRole('button', { name: '编辑资料' }));
 fireEvent.change(screen.getByLabelText('专业'), { target: { value: 'Unsaved major' } });
 fireEvent.click(screen.getByRole('button', { name: '取消编辑' }));
 await answer('取消'); expect(screen.getByLabelText('专业')).toHaveValue('Unsaved major');
 fireEvent.click(screen.getByRole('button', { name: '取消编辑' })); await answer('确定');
 expect(screen.getByRole('button', { name: '编辑资料' })).toBeInTheDocument();
 expect(screen.getByText('Saved major')).toBeInTheDocument(); expect(fetch).toHaveBeenCalledTimes(1);
});
it('one save returns to read mode, keeps the saved Markdown and suppresses repeated submissions', async () => {
 let writes = 0;
 vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
  if (init?.method !== 'PUT') return response(profile);
  writes += 1; await new Promise(resolve => setTimeout(resolve, 20));
  return response({ ...profile, ...JSON.parse(init.body), revision: 1 });
 }));
 setup(); fireEvent.click(await screen.findByRole('button', { name: '编辑资料' }));
 fireEvent.change(screen.getByLabelText('自我介绍（Markdown）'), { target: { value: '# Saved heading' } });
 const form = screen.getByRole('form', { name: '个人资料编辑' });
 fireEvent.submit(form); fireEvent.submit(form);
 await screen.findByRole('button', { name: '编辑资料' }); expect(writes).toBe(1);
 expect(screen.queryByRole('textbox')).toBeNull();
 expect(within(screen.getByRole('region', { name: '我的个人主页' })).getByRole('heading', { name: 'Saved heading' })).toBeInTheDocument();
});

it('the independent profile route preserves edits when Back is canceled and supports confirmed Back/Forward', async () => {
 vi.stubGlobal('fetch', vi.fn(async () => response(profile)));
 const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }); client.setQueryData(['session'], user);
 const router = createMemoryRouter([
  { path: '/app/profile', element: <><NavLink to="/app/settings">设置</NavLink><SettingsEditGuard><PersonalProfilePage/></SettingsEditGuard></> },
  { path: '/app/settings', element: <p>Settings destination</p> },
 ], { initialEntries: ['/app/settings', '/app/profile'], initialIndex: 1 });
 render(<QueryClientProvider client={client}><RouterProvider router={router}/></QueryClientProvider>);
 fireEvent.click(await screen.findByRole('button', { name: '编辑资料' }));
 fireEvent.change(screen.getByLabelText('专业'), { target: { value: 'Keep my draft' } });
 await act(() => router.navigate(-1));
 await answer('取消'); expect(router.state.location.pathname).toBe('/app/profile');
 expect(screen.getByLabelText('专业')).toHaveValue('Keep my draft');
 await act(() => router.navigate(-1)); await answer('确定');
 expect(screen.getByText('Settings destination')).toBeInTheDocument();
 await act(() => router.navigate(1)); await screen.findByRole('button', { name: '编辑资料' });
 expect(screen.queryByRole('textbox')).toBeNull(); expect(screen.queryByText('Keep my draft')).toBeNull();
});

it('imports selected legacy fields into a preserved draft and requires renewed disclosure and AI consent', async () => {
 const savedProfile = { ...profile, revision: 5, bio: 'Existing bio', major: 'Existing major', specialties: 'Existing skill', weeklyAvailableHours: 4, aiUseAllowed: true, visibility: { ...profile.visibility, major: true, specialties: true } };
 const writes: Record<string, unknown>[] = [];
 vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
  if (String(url).includes('/import-candidates')) return response({ items: [{ candidateId: 'candidate', sourceProjectId: 'old-project', sourceProjectName: '历史项目', major: '旧专业', skills: ['旧技能'], weeklyAvailableHours: 7, importedAt: null, createdAt: '2026-10-01' }], nextCursor: null });
  if (init?.method === 'PUT') { const body = JSON.parse(String(init.body)) as Record<string, unknown>; writes.push(body); return response({ ...savedProfile, ...body, revision: 6 }); }
  return response(savedProfile);
 }));
 setup(); fireEvent.click(await screen.findByRole('button', { name: '编辑资料' }));
 fireEvent.change(screen.getByLabelText('自我介绍（Markdown）'), { target: { value: 'Keep drafted bio' } });
 fireEvent.click(screen.getByRole('button', { name: '读取导入候选' }));
 fireEvent.click(await screen.findByLabelText('专业：旧专业'));
 fireEvent.click(screen.getByLabelText('技能与特长：旧技能'));
 fireEvent.click(screen.getByLabelText('每周总可用时间：7 小时'));
 fireEvent.click(screen.getByRole('button', { name: '复制所选字段到草稿' })); await answer('确定');
 expect(screen.getByLabelText('专业')).toHaveValue('旧专业');
 expect(screen.getByLabelText('技能与特长')).toHaveValue('旧技能');
 expect(screen.getByLabelText('每周总可用时间（小时）')).toHaveValue(7);
 expect(screen.getByLabelText('自我介绍（Markdown）')).toHaveValue('Keep drafted bio');
 expect(screen.getByLabelText('公开专业')).not.toBeChecked(); expect(screen.getByLabelText('公开专业')).toBeDisabled();
 const consent = screen.getByLabelText('我同意将上述个人资料交给项目配置的 AI 提供商用于任务推荐'); expect(consent).not.toBeChecked(); expect(consent).toBeDisabled();
 fireEvent.click(screen.getByRole('button', { name: '保存资料与隐私' }));
 await screen.findByText('资料与隐私设置已保存');
 expect(writes[0]).toMatchObject({ expectedRevision: 5, bio: 'Keep drafted bio', major: '旧专业', specialties: '旧技能', weeklyAvailableHours: 7, aiUseAllowed: false, visibility: { major: false, specialties: false }, legacyImports: [{ candidateId: 'candidate', fields: ['major', 'specialties', 'weeklyAvailableHours'] }] });
 fireEvent.click(screen.getByRole('button', { name: '编辑资料' }));
 expect(screen.getByLabelText('我同意将上述个人资料交给项目配置的 AI 提供商用于任务推荐')).not.toBeDisabled();
 expect(within(screen.getByRole('region', { name: '公开展示预览' })).queryByText('7 小时')).toBeNull();
});
