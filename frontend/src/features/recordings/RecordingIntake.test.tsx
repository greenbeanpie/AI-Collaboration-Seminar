import { QueryClient,QueryClientProvider } from '@tanstack/react-query';
import { cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { RecordingIntake } from './RecordingIntake';
import { desktopInvoke } from '../../desktop/bridge';
import { documentRequest } from '../../pages/document-import-client';
const state=vi.hoisted(()=>({draft:{id:'local',accountId:'account',projectId:'project',kind:'photo',state:'stopped',createdAt:'2026-10-11',elapsedMs:0,segments:[{sequence:1,name:'photo.jpg',sizeBytes:10,startMs:0,endMs:0,sha256:'hash'}],interruptions:[]}}));
vi.mock('../../components/FileContributors',()=>({FileContributorPicker:()=>null}));
vi.mock('../../offline/store',()=>({offlineAccount:()=>({id:'account'})}));
vi.mock('../../desktop/bridge',()=>({isDesktop:()=>true,desktopInvoke:vi.fn(async(command:string)=>command==='recording_capabilities'?{audio:true,video:true,photo:true,background:true,devices:[]}:command==='recording_list'?[state.draft]:command==='recording_upload'?{...state.draft,segments:state.draft.segments.map(s=>({...s,fileId:'stored-file'}))}:state.draft)}));
vi.mock('../../desktop/lifecycle',()=>({setDesktopDirty:vi.fn()}));
vi.mock('../../pages/document-import-client',()=>({documentRequest:vi.fn(async()=>({sessionId:'server-session'}))}));
vi.mock('../../pages/source-workflows',()=>({uploadProjectFile:vi.fn()}));
beforeEach(()=>vi.clearAllMocks());afterEach(cleanup);
function show(){render(<QueryClientProvider client={new QueryClient()}><RecordingIntake projectId="project"/></QueryClientProvider>);}
it('native photo start captures locally without sending a photo action or creating a server session',async()=>{show();await screen.findByText('确认上传 / 重试');fireEvent.change(screen.getByLabelText('采集方式'),{target:{value:'photo'}});fireEvent.click(screen.getByText('拍照 / 重拍'));await waitFor(()=>expect(desktopInvoke).toHaveBeenCalledWith('recording_start',expect.objectContaining({kind:'photo'})));expect(vi.mocked(desktopInvoke).mock.calls.some(c=>c[0]==='recording_action')).toBe(false);expect(documentRequest).not.toHaveBeenCalled();});
it('creates a server session only after explicit confirmation and registers native sequence one unchanged',async()=>{show();const upload=await screen.findByText('确认上传 / 重试');expect(documentRequest).not.toHaveBeenCalled();fireEvent.click(upload);await waitFor(()=>expect(documentRequest).toHaveBeenCalledWith('/api/v1/projects/project/recording-sessions/server-session/segments/1',expect.objectContaining({method:'PUT',body:expect.objectContaining({fileId:'stored-file'})})));expect(desktopInvoke).toHaveBeenCalledWith('recording_upload',expect.objectContaining({sessionId:'server-session'}));});
