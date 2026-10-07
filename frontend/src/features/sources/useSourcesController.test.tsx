import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useSourcesController } from './useSourcesController';
import { api } from '../../api/client';
import { importBrowserFile } from '../../pages/document-import-client';
const project = vi.hoisted(() => ({ aiCollaborationEnabled: true }));
vi.mock('../../components/ProjectShell', () => ({ useProject: () => ({ projectId: 'p', project }) }));
vi.mock('../../pages/source-lifecycle', () => ({ useSourceLifecycle: () => ({ busy: false }) }));
vi.mock('./useSourceQueries', () => ({ useSourceQueries: () => ({ capabilityQuery: {}, capability: { features: { aiEnabled: true }, limits: { maxFileBytes: null } }, sourceQuery: {}, sources: [], versionQueries: [], versionsBySourceId: {} }) }));
vi.mock('../../pages/source-workflows', async original => ({ ...await original<typeof import('../../pages/source-workflows')>(), uploadProjectFile: vi.fn().mockResolvedValue('f'), readTrackedSourceJobs: () => [], writeTrackedSourceJobs: vi.fn(), rememberSourceFile: vi.fn() }));
vi.mock('../../pages/document-import-client', () => ({ importBrowserFile: vi.fn().mockResolvedValue({ textReady: true, warnings: [], needsImages: 0 }), documentRequest: vi.fn() }));
vi.mock('../../api/client', async original => ({ ...await original<typeof import('../../api/client')>(), api: { post: vi.fn().mockResolvedValue({ sourceId: 's', sourceVersionId: 'v', title: '成果.docx' }) } }));
beforeEach(() => { vi.clearAllMocks(); project.aiCollaborationEnabled = true; });
afterEach(cleanup);
function controller() { return renderHook(() => useSourcesController(), { wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={new QueryClient()}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider> }); }
it('leaves AI-enabled uploaded documents to the background service without browser parsing or duplicate parse jobs', async () => {
  const { result } = controller();
  act(() => { result.current.setKind('file'); result.current.setFile(new File(['docx'], '成果.docx')); });
  await act(async () => { await result.current.submitSource({ preventDefault: vi.fn() } as unknown as React.FormEvent<HTMLFormElement>); });
  expect(importBrowserFile).not.toHaveBeenCalled();
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(api.post).toHaveBeenCalledWith('/api/v1/projects/p/sources', expect.objectContaining({ fileId: 'f' }), expect.any(Object));
  expect(result.current.successMessage).toContain('关闭页面仍会继续');
});
it('retains manual non-AI document text import when the project switch is off', async () => {
  project.aiCollaborationEnabled = false;
  const { result } = controller();
  act(() => { result.current.setKind('file'); result.current.setFile(new File(['docx'], '成果.docx')); });
  await act(async () => { await result.current.submitSource({ preventDefault: vi.fn() } as unknown as React.FormEvent<HTMLFormElement>); });
  expect(importBrowserFile).toHaveBeenCalledTimes(1);
  expect(api.post).toHaveBeenCalledTimes(1);
});
