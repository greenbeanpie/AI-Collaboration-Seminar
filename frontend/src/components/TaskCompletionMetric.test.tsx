import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { TaskCompletionMetric } from './TaskCompletionMetric';

afterEach(cleanup);
const defaults = { variant: 'overview' as const, completed: 0, total: 20, available: true, unavailableMessage: '正在读取任务进度' };

describe('task completion metric', () => {
  it('renders the overview count, percentage and accessible solid progress track', () => {
    const { container } = render(<TaskCompletionMetric {...defaults} />);
    expect(screen.getByText('0/20')).toBeInTheDocument();
    expect(screen.getByText('0%')).toBeInTheDocument();
    const bar = screen.getByRole('progressbar', { name: '任务完成率' });
    expect(bar).toHaveAttribute('aria-valuenow', '0');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
    expect(bar).toHaveAttribute('aria-valuetext', '0%，0 / 20 项任务已完成');
    expect(bar.firstChild).toHaveStyle({ width: '0%' });
    expect(container.firstChild).toHaveAttribute('data-completion-tone', 'red');
  });
  it('renders the dashboard percentage and completed/total count', () => {
    render(<TaskCompletionMetric {...defaults} variant="dashboard" completed={2} total={25} />);
    expect(screen.getByText('2 / 25 项任务已完成')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '8');
    expect(screen.getByRole('progressbar').firstChild).toHaveStyle({ width: '8%' });
    expect(document.querySelector('.dashboard-metric-value')).toHaveTextContent('8%');
  });
  it('updates the card and progress color together after completion or reopening', () => {
    const { container, rerender } = render(<TaskCompletionMetric {...defaults} completed={10} />);
    expect(container.firstChild).toHaveAttribute('data-completion-tone', 'yellow');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
    rerender(<TaskCompletionMetric {...defaults} completed={20} />);
    expect(container.firstChild).toHaveAttribute('data-completion-tone', 'green');
    expect(screen.getByRole('progressbar').firstChild).toHaveStyle({ width: '100%' });
    rerender(<TaskCompletionMetric {...defaults} completed={1} />);
    expect(container.firstChild).toHaveAttribute('data-completion-tone', 'red');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '5');
  });
  it('shows an empty project as 0% with an explicit no-tasks description', () => {
    const { container } = render(<TaskCompletionMetric {...defaults} total={0} />);
    expect(screen.getByText('0/0')).toBeInTheDocument();
    expect(screen.getByText('暂无任务')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuetext', '0%，暂无任务');
    expect(container.firstChild).toHaveAttribute('data-completion-tone', 'red');
  });
  it.each(['正在读取任务进度', '任务统计暂不可用'])('hides stale counts and color while unavailable: %s', (unavailableMessage) => {
    const { container } = render(<TaskCompletionMetric {...defaults} completed={20} available={false} unavailableMessage={unavailableMessage} />);
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText(unavailableMessage)).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.queryByText('20/20')).not.toBeInTheDocument();
    expect(container.firstChild).not.toHaveAttribute('data-completion-tone');
  });
});

function luminance(hex: string) {
  const channels = [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
}
function contrast(a: string, b: string) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + .05) / (values[1] + .05);
}
it('keeps light/dark colors solid with readable labels and distinguishable progress fills', () => {
  const css = readFileSync('src/components/TaskCompletionMetric.css', 'utf8');
  expect(css).not.toContain('gradient(');
  for (const dark of [false, true]) for (const tone of ['red', 'yellow', 'green']) {
    const selector = `${dark ? ':root[data-theme="dark"] ' : ''}.task-completion-card[data-completion-tone="${tone}"]`;
    const body = css.slice(css.indexOf(`${selector} {`)).split('}')[0];
    const color = (variable: string) => body.match(new RegExp(`--completion-${variable}: (#[0-9a-f]{6})`))![1];
    expect(contrast(dark ? '#b0bfd4' : '#5d6b82', color('background'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(color('fill'), color('track'))).toBeGreaterThanOrEqual(3);
  }
  expect(css).toContain('@media (forced-colors: active)');
});
