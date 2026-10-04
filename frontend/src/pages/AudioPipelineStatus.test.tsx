import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AudioPipelineStatus, type AudioPipelineInfo } from './AudioPipelineStatus';
afterEach(cleanup);
const waiting: AudioPipelineInfo = { phase:'waiting_config', qualityScore:0.7, reasons:['转录质量未达到门槛'], transcriptAvailable:true, canResumeFallback:false };
it('retains low-quality transcript and cannot resume without Gemini configuration', () => {
  const resume=vi.fn(), refresh=vi.fn();
  render(<AudioPipelineStatus audio={waiting} onResume={resume} onRefresh={refresh}/>);
  expect(screen.getByText('等待 Gemini 配置')).toBeInTheDocument();
  expect(screen.getByText(/0.70.*0.85/)).toBeInTheDocument();
  expect(screen.getByText('机器转录已私有保存，可继续处理。')).toBeInTheDocument();
  expect(screen.getByRole('button',{name:'继续 Gemini 回退'})).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'刷新配置与状态'}));
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(resume).not.toHaveBeenCalled();
});
it('only requests paid continuation after the explicit configured action', () => {
  const resume=vi.fn();
  render(<AudioPipelineStatus audio={{...waiting,canResumeFallback:true}} onResume={resume} onRefresh={vi.fn()}/>);
  expect(resume).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'继续 Gemini 回退'}));
  expect(resume).toHaveBeenCalledTimes(1);
});
it('does not present quality score as original audio accuracy', () => {
  render(<AudioPipelineStatus audio={{...waiting,phase:'ready',qualityScore:0.85}} onResume={vi.fn()} onRefresh={vi.fn()}/>);
  expect(screen.getByText(/不是原音准确率保证/)).toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'继续 Gemini 回退'})).toBeNull();
});
