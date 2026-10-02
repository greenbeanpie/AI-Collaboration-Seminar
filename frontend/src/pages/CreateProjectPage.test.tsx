/* eslint-disable @typescript-eslint/no-explicit-any -- API fixtures cover multiple server response shapes in this interaction test. */
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { CreateProjectWizardPage as CreateProjectPage } from './CreateProjectPage';
const mocks = vi.hoisted(() => ({
  get: vi.fn(), post: vi.fn(), patch: vi.fn(), request: vi.fn()
}));
vi.mock('../api/client', () => ({
  api: {
    get: mocks.get, post: mocks.post, patch: mocks.patch
  }, request: mocks.request
}));
vi.mock('../auth', () => ({
  useSession: () => ({
    data: {
      id: 'owner'
    }, isLoading: false
  }), useCapabilities: () => ({
    data: {
      features: {
        aiEnabled: true
      }, limits: {
        maxFileBytes: 10485760
      }
    }
  })
}));
vi.mock('./LegacyCreateProjectPage', () => ({
  LegacyCreateProjectPage: () => null
}));
vi.mock('./project-creation-workflow', () => ({
  readCreationDraft: () => null, creationFileExtensions: '.txt', validateCreationFiles: () => null
}));
afterEach(cleanup);
let draft: any;
beforeEach(() => {
  sessionStorage.clear();
  vi.clearAllMocks();
  draft = {
    id: 'draft-1', status: 'active', revision: 1, payload: {
      name: '新项目', description: '', brief: '', teamSize: 1, inviteUsernames: [], inviteLabels: [], aiCollaborationEnabled: false
    }, preview: null, previewRevision: null, previewState: 'none', previewError: null, files: [], projectId: null, updatedAt: '2026-10-02'
  };
  mocks.get.mockResolvedValue({
    items: []
  });
  mocks.post.mockImplementation(async (path: string, body: any) => {
    if (path === '/api/v1/creation-drafts') {
      draft = {
        ...draft, payload: body
      };
      return draft;
    }
    if (path.endsWith('/preview')) {
      draft = {
        ...draft, preview: {
          mode: body.mode, goal: body.goal, tasks: body.tasks
        }, previewState: 'ready', previewRevision: draft.revision
      };
      return draft;
    }
    if (path.endsWith('/commit')) {
      return {
        projectId: 'created', invitations: [], usernameInvitations: []
      };
    }
    throw new Error(path);
  });
  mocks.patch.mockImplementation(async (_p: string, b: any) => {
    draft = {
      ...draft, payload: b.payload, revision: draft.revision + 1, previewState: 'none'
    };
    return draft;
  });
});
function mount() {
  render(<QueryClientProvider client={new QueryClient({
    defaultOptions: {
      queries: {
        retry: false
      }, mutations: {
        retry: false
      }
    }
  })}><MemoryRouter><CreateProjectPage /></MemoryRouter></QueryClientProvider>);
}
async function next() {
  fireEvent.click(screen.getByRole('button', {
    name: '下一步'
  }));
  await waitFor(() => expect(screen.queryByText('正在保存或核对结果，请稍候…')).not.toBeInTheDocument());
}
describe('project creation wizard', () => {
  it('previews one editable main goal and stable keyed sibling dependencies without a duplicate root task', async () => {
    mount(); fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: '依赖项目' } });
    fireEvent.change(screen.getByLabelText(/^主目标（可选）/), { target: { value: '交付可复现成果' } });
    await next(); await next(); await next();
    fireEvent.click(screen.getByRole('button', { name: '添加手动任务' }));
    fireEvent.click(screen.getByRole('button', { name: '添加手动任务' }));
    const titles = screen.getAllByLabelText('标题'); const criteria = screen.getAllByLabelText('验收标准');
    fireEvent.change(titles[0]!, { target: { value: '准备资料' } }); fireEvent.change(criteria[0]!, { target: { value: '正文完整' } });
    fireEvent.change(titles[1]!, { target: { value: '生成成果' } }); fireEvent.change(criteria[1]!, { target: { value: '复现成功' } });
    const dependencyGroups = screen.getAllByRole('group', { name: '前置子任务' });
    fireEvent.click(within(dependencyGroups[1]!).getByLabelText('准备资料'));
    fireEvent.click(screen.getByRole('button', { name: '保存当前任务预览' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '进入创建预览' })).not.toBeDisabled());
    const previewBody = mocks.post.mock.calls.find(([path]) => String(path).endsWith('/preview'))?.[1] as { goal: { title: string }; tasks: Array<{ key: string; dependsOn: string[] }> };
    expect(previewBody.goal.title).toBe('交付可复现成果'); expect(previewBody.tasks).toHaveLength(2);
    expect(previewBody.tasks[0]?.key).toBeTruthy(); expect(previewBody.tasks[1]?.dependsOn).toEqual([previewBody.tasks[0]?.key]);
    fireEvent.change(screen.getByLabelText(/^主目标预览/), { target: { value: '尚未保存的新目标' } });
    expect(screen.getByRole('button', { name: '进入创建预览' })).toBeDisabled();
  });
  it('does not create a project before all steps, explicit task preview and final review', async () => {
    mount();
    fireEvent.change(screen.getByLabelText('项目名称'), {
      target: {
        value: '新项目'
      }
    });
    await next();
    expect(screen.getByRole('heading', {
      name: '上传文件'
    })).toBeInTheDocument();
    await next();
    expect(screen.getByRole('heading', {
      name: '人数与邀请'
    })).toBeInTheDocument();
    await next();
    expect(screen.getByRole('heading', {
      name: '目标与子任务预览'
    })).toBeInTheDocument();
    expect(screen.getByRole('button', {
      name: '进入创建预览'
    })).toBeDisabled();
    expect(mocks.post.mock.calls.some(([path]) => String(path).endsWith('/commit'))).toBe(false);
    fireEvent.click(screen.getByRole('button', {
      name: '确认暂不创建任务'
    }));
    await waitFor(() => expect(screen.getByRole('button', {
      name: '进入创建预览'
    })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', {
      name: '进入创建预览'
    }));
    expect(screen.getByRole('button', {
      name: '确认并创建项目'
    })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', {
      name: '我已复核项目、文件、人数、邀请与任务配置'
    }));
    fireEvent.click(screen.getByRole('button', {
      name: '确认并创建项目'
    }));
    await screen.findByRole('heading', {
      name: '项目已创建'
    });
    expect(mocks.post.mock.calls.filter(([p]) => String(p).endsWith('/commit'))).toHaveLength(1);
    expect(mocks.post.mock.calls.some(([p]) => p === '/api/v1/projects')).toBe(false);
  });
  it('invalidates saved task preview when a previously completed configuration step changes', async () => {
    mount();
    fireEvent.change(screen.getByLabelText('项目名称'), {
      target: {
        value: '新项目'
      }
    });
    await next();
    await next();
    await next();
    fireEvent.click(screen.getByRole('button', {
      name: '确认暂不创建任务'
    }));
    await waitFor(() => expect(screen.getByRole('button', {
      name: '进入创建预览'
    })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', {
      name: '上一步'
    }));
    fireEvent.change(screen.getByLabelText('组员总人数（含负责人）'), {
      target: {
        value: '2'
      }
    });
    await next();
    expect(screen.getByRole('button', {
      name: '进入创建预览'
    })).toBeDisabled();
    expect(screen.getByText('配置已变化，请重新保存预览。')).toBeInTheDocument();
  });
});

it('requests background AI preview, locks edits and adopts the polled result', async () => {
 let finish!: (value: any) => void;
 mocks.get.mockImplementation((path: string) => path.endsWith('/draft-1') ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({items:[]}));
 const original = mocks.post.getMockImplementation()!;
 mocks.post.mockImplementation(async (path: string, body: any) => path.endsWith('/preview') && body.mode === 'ai' ? {...draft,previewState:'running'} : original(path,body));
 mount();fireEvent.change(screen.getByLabelText('项目名称'),{target:{value:'异步项目'}});fireEvent.click(screen.getByRole('checkbox',{name:/AI 智能协作/}));await next();await next();await next();
 fireEvent.click(screen.getByRole('button',{name:'生成 AI 拆分预览'}));
 await screen.findByText(/AI 正在后台处理文件/);expect(screen.getByLabelText(/^主目标预览/)).toBeDisabled();
 expect(mocks.post.mock.calls.find(([path])=>String(path).endsWith('/preview'))?.[1]).toMatchObject({background:true});
 await waitFor(()=>expect(finish).toBeTypeOf('function'));
 finish({...draft,previewState:'ready',previewRevision:draft.revision,preview:{mode:'ai',goal:{title:'后台目标',detail:'调查后生成'},tasks:[]}});
 await waitFor(()=>expect(screen.getByLabelText(/^主目标预览/)).toHaveValue('后台目标'));
 expect(screen.getByRole('button',{name:'进入创建预览'})).not.toBeDisabled();
});
