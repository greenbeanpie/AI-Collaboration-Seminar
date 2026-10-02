import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { RemovedSourceNotice } from './RemovedSourceNotice';

afterEach(cleanup);

it('labels retired evidence without a link or a read request', () => {
  render(<RemovedSourceNotice payload={{ references: [{ resourceType: 'decision', resourceId: 'old' }, { resourceType: 'material', resourceId: 'current' }] }} />);
  expect(screen.getByRole('status')).toHaveTextContent('来源已移除：本记录包含 1 项历史决策记录引用');
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
});

it.each([null, {}, { references: [null, { resourceType: 'material' }] }])('does not mark available evidence as removed', payload => {
  const { container } = render(<RemovedSourceNotice payload={payload} />);
  expect(container).toBeEmptyDOMElement();
});
