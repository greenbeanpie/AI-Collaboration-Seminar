import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import { ExportPage } from './ExportPage';

vi.mock('../components/ProjectShell', () => ({ useProject: () => ({ projectId: 'p', project: { name: '测试项目' } }) }));
vi.mock('../api/client', async original => ({ ...await original<typeof import('../api/client')>(), api: { get: vi.fn() } }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it('keeps task and event exports without the retired recording sections', async () => {
  vi.mocked(api.get).mockResolvedValue({ project: { name: '测试项目' }, tasks: [{ title: '任务' }], events: [{ type: 'task.claimed' }] } as never);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><ExportPage /></QueryClientProvider>);
  await screen.findByText('已读取服务端汇总');
  expect(screen.getByText('过程事件')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '预览 Markdown' }));
  expect(screen.getByText(/## 近期过程事件/)).toBeInTheDocument();
  expect(screen.queryByText(/团队决策|成员贡献及更正|第三方资源声明/)).not.toBeInTheDocument();
  client.clear();
});
