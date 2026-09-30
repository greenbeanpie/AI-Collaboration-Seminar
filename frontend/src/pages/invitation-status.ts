export function invitationStatus(invitation: { revokedAt: string | null; expiresAt: string; maxUses: number | null; usedCount: number }, now = Date.now()) {
  if (invitation.revokedAt) return '已撤销';
  if (new Date(invitation.expiresAt).getTime() <= now) return '已过期';
  if (invitation.maxUses !== null && invitation.usedCount >= invitation.maxUses) return '已用完';
  return '有效';
}
