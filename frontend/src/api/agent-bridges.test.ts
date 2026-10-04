import { beforeEach, expect, it, vi } from 'vitest';
import { accountRequest } from './simplification';
import { bridgeApi } from './agent-bridges';
import { idempotencyKeyForIntent } from '../pages/aiWorkflowSupport';

vi.mock('./simplification', () => ({ accountRequest: vi.fn() }));
vi.mock('../offline/store', () => ({ offlineAccount: () => null }));
vi.mock('../pages/aiWorkflowSupport', () => ({ idempotencyKeyForIntent: vi.fn(async (namespace: string) => namespace), completeIntent: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
it('deduplicates within one actor but keeps identical approval requests for two actors separate', async () => {
  let finishA!: (value: unknown) => void;
  let finishB!: (value: unknown) => void;
  vi.mocked(accountRequest).mockImplementationOnce(() => new Promise(resolve => { finishA = resolve; })).mockImplementationOnce(() => new Promise(resolve => { finishB = resolve; }));
  const firstA = bridgeApi.approve('pair', ['project'], 'actorA');
  const duplicateA = bridgeApi.approve('pair', ['project'], 'actorA');
  const firstB = bridgeApi.approve('pair', ['project'], 'actorB');
  await vi.waitFor(() => expect(accountRequest).toHaveBeenCalledTimes(2));
  expect(idempotencyKeyForIntent).toHaveBeenCalledWith('bridge:actorA:/api/v1/agent-bridges/pairings/pair/approve', { projectIds: ['project'] });
  expect(idempotencyKeyForIntent).toHaveBeenCalledWith('bridge:actorB:/api/v1/agent-bridges/pairings/pair/approve', { projectIds: ['project'] });
  finishA({ actor: 'A' }); finishB({ actor: 'B' });
  await expect(firstA).resolves.toEqual({ actor: 'A' });
  await expect(duplicateA).resolves.toEqual({ actor: 'A' });
  await expect(firstB).resolves.toEqual({ actor: 'B' });
});
