import { expect, it } from 'vitest';
import { invitationStatus } from './invitation-status';

it('does not count exhausted, expired or revoked invitations as available', () => {
  const invitation = { revokedAt: null, expiresAt: '2026-10-07T00:00:00Z', maxUses: 1, usedCount: 1 };
  const now = Date.parse('2026-09-30T00:00:00Z');
  expect(invitationStatus(invitation, now)).toBe('已用完');
  expect(invitationStatus({ ...invitation, usedCount: 0 }, now)).toBe('有效');
  expect(invitationStatus({ ...invitation, maxUses: null }, now)).toBe('有效');
  expect(invitationStatus(invitation, Date.parse(invitation.expiresAt))).toBe('已过期');
  expect(invitationStatus({ ...invitation, revokedAt: '2026-09-30T00:00:00Z' }, now)).toBe('已撤销');
});
