import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SystemOverviewPage } from './SystemOverviewPage';

const state = vi.hoisted(() => ({ teamSizeLimit: null as number | null, environment: 'production', emailMode: 'resend', mode: 'success', refetch: vi.fn() }));
vi.mock('../auth', () => ({ useCapabilities: () => ({
  data: state.mode === 'success' ? {
    environment: state.environment, apiVersion: 'v1',
    features: { aiEnabled: true, webFetch: true, emailMode: state.emailMode },
    limits: { maxFileBytes: 10485760, maxPdfPages: 30, pageImageMaxEdge: 2000, pageImageMaxBytes: 2097152, concurrentAiTasksPerProject: 2 },
    competitionTemplate: { teamSizeLimit: state.teamSizeLimit },
  } : undefined,
  error: state.mode === 'error' ? new Error('能力读取失败') : null,
  refetch: state.refetch,
}) }));

afterEach(() => { cleanup(); state.teamSizeLimit = null; state.environment = 'production'; state.emailMode = 'resend'; state.mode = 'success'; state.refetch.mockClear(); });

it.each([{ limit: null, display: '不设上限' }, { limit: 5, display: '5 人' }])('preserves team capacity display: $display', ({ limit, display }) => {
  state.teamSizeLimit = limit; render(<SystemOverviewPage />);
  expect(screen.getByRole('heading', { name: '系统概况' })).toBeInTheDocument();
  expect(screen.getByText('项目人数').parentElement?.querySelector('strong')?.textContent).toBe(display);
});
it('preserves backend limits and service statuses', () => {
  render(<SystemOverviewPage />);
  for (const label of ['环境', 'API 版本', 'AI 服务', '网页抓取', '邮箱验证码模式', '文件大小上限', 'PDF 页数上限', '扫描页长边', '单页图片上限', 'AI 并发上限', '项目人数']) expect(screen.getByText(label)).toBeInTheDocument();
  for (const value of ['production', 'v1', '已启用', '可用', 'resend', '10 MiB', '30 页', '2000 px', '2.0 MiB', '2 项 / 项目']) expect(screen.getByText(value)).toBeInTheDocument();
  expect(screen.getByText(/官方申报书/)).toBeInTheDocument();
});
it('shows local echo warning only for local echo capability', () => {
  state.environment = 'local'; state.emailMode = 'echo'; render(<SystemOverviewPage />);
  expect(screen.getByText('本地邮箱回显模式')).toBeInTheDocument(); cleanup();
  state.environment = 'production'; render(<SystemOverviewPage />);
  expect(screen.queryByText('本地邮箱回显模式')).toBeNull();
});
it('shows loading state while capabilities are pending', () => {
  state.mode = 'loading'; render(<SystemOverviewPage />); expect(screen.getByText('正在读取后端能力……')).toBeInTheDocument();
});
it('shows a retry action for capabilities errors', () => {
  state.mode = 'error'; render(<SystemOverviewPage />);
  expect(screen.getByText('能力读取失败')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /重试/ })); expect(state.refetch).toHaveBeenCalledOnce();
});
