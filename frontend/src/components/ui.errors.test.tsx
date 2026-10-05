import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { ErrorNotice } from './ui';
afterEach(cleanup);
it.each(['INTERNAL','AI_UNAVAILABLE','INVALID_STATE','NETWORK_ERROR'])('renders only the complete backend reason for %s', code => {
  const message = ' 原因包含或\n<script>alert(1)</script>\n最后一行 ';
  const error = new ApiError(500,{error:{code,message,retryable:true,stage:'internal',action:'contact_admin'},requestId:'hidden-id'});
  render(<ErrorNotice error={error}/>);
  const alert = screen.getByRole('alert');
  expect(alert.textContent).toBe(message); expect(alert.querySelector('script')).toBeNull();
  expect(alert.querySelector('strong')).toHaveStyle({whiteSpace:'pre-wrap'});
  expect(alert.querySelector('details')).toBeNull();
});
it('renders a nested failed job reason without metadata or stack', () => {
  const message = '模型处理失败\n第二行';
  render(<ErrorNotice error={{error:{message,code:'INTERNAL',requestId:'hidden-id',stack:'hidden-stack'}}}/>);
  expect(screen.getByRole('alert').textContent).toBe(message);
});
