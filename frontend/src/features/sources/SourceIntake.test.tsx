import { useEffect, useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SourceIntake } from './SourceIntake';
import type { useSourcesController } from './useSourcesController';

const capture = vi.hoisted(() => ({ mounted: vi.fn(), unmounted: vi.fn() }));
vi.mock('../recordings/RecordingIntake', () => ({ RecordingIntake: ({ onActivityChange }: { onActivityChange?: (active: boolean) => void }) => {
  const [recording, setRecording] = useState(false);
  useEffect(() => { capture.mounted(); return () => { capture.unmounted(); }; }, []);
  return <section aria-label="直接采集资料"><button onClick={() => setRecording(true)}>模拟预览</button><button onClick={() => onActivityChange?.(true)}>模拟录制</button><button onClick={() => onActivityChange?.(false)}>模拟停止</button><p>{recording ? '模拟录制中' : '模拟待机'}</p></section>;
} }));
vi.mock('../../components/FileContributors', () => ({ FileContributorPicker: () => <p>贡献者选择</p> }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function show(webFetch = true, submitting = false) {
  const submitSource = vi.fn(event => event.preventDefault());
  function Intake() {
    const [kind, setKind] = useState('paste'), [text, setText] = useState(''), [title, setTitle] = useState(''), [url, setUrl] = useState('');
    const model = { projectId: 'p', capability: { features: { webFetch, aiEnabled: false } }, kind, setKind, title, setTitle, text, setText, url, setUrl, file: null, setFile: vi.fn(), parseMode: 'auto', setParseMode: vi.fn(), importAbort: { current: null }, contributorIds: undefined, setContributorIds: vi.fn(), pendingUpload: null, setPendingUpload: vi.fn(), submitting, fileInitIntentKeys: { current: new Map() }, submitSource } as unknown as ReturnType<typeof useSourcesController>;
    return <SourceIntake model={model} initialMethod="document" documentForm={<form><label>文档标题<input /></label><button>创建文档</button></form>} />;
  }
  render(<Intake />);
  return submitSource;
}

it('defaults to document creation and exposes every import and capture method in the shared layout', () => {
  const submit = show();
  expect(screen.getByRole('heading', { name: '新增资料' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '新建文档' })).toHaveAttribute('aria-pressed', 'true');
  expect(capture.mounted).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '粘贴文本' }));
  fireEvent.change(screen.getByLabelText(/通知或项目资料原文/), { target: { value: '原文保留' } });
  fireEvent.click(screen.getByRole('button', { name: '导入来源' }));
  expect(submit).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: '网页链接' }));
  expect(screen.getByLabelText(/公开网页地址/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '文件' }));
  expect(screen.getByLabelText(/选择来源文件/)).toBeInTheDocument();
  expect(screen.getByText('贡献者选择')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '粘贴文本' }));
  expect(screen.getByLabelText(/通知或项目资料原文/)).toHaveValue('原文保留');
});

it('preserves the mounted recording instance and its state across intake method changes', () => {
  show();
  fireEvent.click(screen.getByRole('button', { name: '录音 / 录像 / 拍照' }));
  fireEvent.click(screen.getByRole('button', { name: '模拟预览' }));
  fireEvent.click(screen.getByRole('button', { name: '新建文档' }));
  expect(screen.getByText('模拟录制中')).not.toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '录音 / 录像 / 拍照' }));
  expect(screen.getByText('模拟录制中')).toBeVisible();
  expect(capture.mounted).toHaveBeenCalledTimes(1);
  expect(capture.unmounted).not.toHaveBeenCalled();
});

it('keeps unavailable web import disabled while other methods remain usable', () => {
  show(false);
  expect(screen.getByRole('button', { name: '网页链接' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '文件' })).toBeEnabled();
});

it('prevents changing methods during an import request', () => {
  show(true, true);
  for (const name of ['新建文档', '粘贴文本', '网页链接', '文件', '录音 / 录像 / 拍照']) expect(screen.getByRole('button', { name })).toBeDisabled();
});


it('keeps recording controls visible by locking method changes until recording or upload ends', () => {
  show();
  fireEvent.click(screen.getByRole('button', { name: '录音 / 录像 / 拍照' }));
  fireEvent.click(screen.getByRole('button', { name: '模拟录制' }));
  expect(screen.getByRole('button', { name: '新建文档' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '文件' })).toBeDisabled();
  expect(screen.getByRole('region', { name: '直接采集资料' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '模拟停止' }));
  expect(screen.getByRole('button', { name: '新建文档' })).toBeEnabled();
});
