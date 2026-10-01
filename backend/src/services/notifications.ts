import type { Env } from '../env';
import { newId, nowIso } from '../core/db';
import { isPushConfigured, sendWebPush } from './web-push';

export type NotificationKind = 'source_added' | 'requirements_ready' | 'requirements_confirmed' | 'requirement_changed' | 'ticket_reply' | 'ticket_status';
const content: Record<NotificationKind, [string, string]> = {
  source_added: ['项目新增要求来源', '你参与的项目新增了要求来源，请进入项目查看。'],
  requirements_ready: ['项目要求解析完成', '你参与的项目有新的要求草稿待核对。'],
  requirements_confirmed: ['项目要求已确认', '你参与的项目已确认要求，请查看最新版本。'],
  requirement_changed: ['项目要求已更新', '你参与的项目要求发生更改，请查看最新内容。'],
  ticket_reply: ['支持工单有新回复', '与你相关的支持工单有新回复，请登录查看。'],
  ticket_status: ['支持工单状态更新', '与你相关的支持工单状态已更新，请登录查看。'],
};
/** Used on feed, read/dismiss and immediately before each send. Current access always wins. */
export const notificationVisibleSql = (userExpression: string) => `(
  (e.scope = 'project' AND EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = e.resource_id AND m.user_id = ${userExpression}))
  OR (e.scope = 'ticket' AND EXISTS (SELECT 1 FROM support_tickets t WHERE t.id = e.resource_id AND
    (t.owner_id = ${userExpression} OR EXISTS (SELECT 1 FROM auth_accounts a WHERE a.user_id = ${userExpression}
      AND COALESCE(a.account_role,CASE WHEN a.is_admin = 1 THEN 'admin' ELSE 'user' END) IN ('admin','super_admin')))))
)`;
interface EventInput {
  key: string; kind: NotificationKind; scope: 'project' | 'ticket'; resourceId: string;
  actorId?: string | null; url: string; now?: string;
  record: { table: 'sources' | 'requirement_sets' | 'requirements' | 'support_ticket_messages'; id: string };
}
/** Append these statements to the same D1 batch as the business change: durable, deduplicated and atomic. */
export function notificationStatements(env: Env, input: EventInput): D1PreparedStatement[] {
  const now = input.now ?? nowIso(); const [title, body] = content[input.kind];
  if (!/^\/app\/(?:projects\/[0-9a-f-]+\/(?:sources|requirements)|support\/[0-9a-f-]+)$/.test(input.url)) throw new Error('Unsafe notification URL');
  const statements = [
    env.DB.prepare(`INSERT OR IGNORE INTO notification_events(id,event_key,kind,scope,resource_id,actor_id,title,body,url,created_at)
      SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10 WHERE EXISTS (SELECT 1 FROM ${input.record.table} WHERE id = ?11)`)
      .bind(newId(), input.key, input.kind, input.scope, input.resourceId, input.actorId ?? null, title, body, input.url, now, input.record.id),
    env.DB.prepare(`INSERT OR IGNORE INTO notification_inbox(event_id,user_id)
      SELECT e.id,u.id FROM notification_events e JOIN users u JOIN auth_accounts a ON a.user_id = u.id
      WHERE e.event_key = ?1 AND a.password_hash IS NOT NULL AND ${notificationVisibleSql('u.id')}
      AND (e.scope = 'project' OR e.actor_id IS NULL OR u.id != e.actor_id)
      AND (e.scope != 'project' OR EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = e.resource_id AND m.user_id = u.id AND m.joined_at <= e.created_at))`)
      .bind(input.key),
  ];
  if (isPushConfigured(env)) statements.push(env.DB.prepare(`INSERT OR IGNORE INTO notification_push_outbox(event_id,subscription_id,available_at,created_at,updated_at)
    SELECT e.id,s.id,e.created_at,e.created_at,e.created_at FROM notification_events e JOIN notification_inbox n ON n.event_id = e.id
      JOIN push_subscriptions s ON s.user_id = n.user_id LEFT JOIN notification_settings p ON p.user_id = n.user_id
    WHERE e.event_key = ?1 AND s.disabled_at IS NULL AND s.created_at <= e.created_at AND COALESCE(p.push_enabled,1) = 1`)
    .bind(input.key));
  return statements;
}

/** Revocation is recoverable; expired provider endpoints are never reassigned to another account. */
export async function revokeDevice(env: Env, userId: string, id: string, sessionHash?: string): Promise<void> {
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare("UPDATE push_subscriptions SET disabled_at = ?3, disabled_reason = 'revoked', updated_at = ?3 WHERE id = ?1 AND user_id = ?2 AND (?4 IS NULL OR session_hash = ?4)").bind(id, userId, now, sessionHash ?? null),
    env.DB.prepare("UPDATE notification_push_outbox SET status = 'cancelled', lease_until = NULL, updated_at = ?2 WHERE subscription_id = ?1 AND status IN ('pending','sending') AND EXISTS (SELECT 1 FROM push_subscriptions s WHERE s.id = ?1 AND s.user_id = ?3 AND s.disabled_at IS NOT NULL)").bind(id, now, userId),
  ]);
}

/** A bounded cron batch. No network calls when VAPID is not configured. */
export async function dispatchNotifications(env: Env): Promise<void> {
  if (!isPushConfigured(env)) return;
  const now = nowIso();
  const due = await env.DB.prepare(`SELECT event_id,subscription_id FROM notification_push_outbox
    WHERE status IN ('pending','sending') AND available_at <= ?1 AND (lease_until IS NULL OR lease_until <= ?1)
    ORDER BY available_at LIMIT 20`).bind(now).all<{ event_id: string; subscription_id: string }>();
  for (const item of due.results) {
    const lease = new Date(Date.now() + 60_000).toISOString();
    const claim = await env.DB.prepare(`UPDATE notification_push_outbox SET status='sending',attempts=attempts+1,lease_until=?3,updated_at=?4
      WHERE event_id=?1 AND subscription_id=?2 AND status IN ('pending','sending') AND (lease_until IS NULL OR lease_until<=?4)`)
      .bind(item.event_id, item.subscription_id, lease, now).run();
    if (claim.meta.changes !== 1) continue;
    const row = await env.DB.prepare(`SELECT e.id,e.title,e.body,e.url,s.user_id,s.endpoint,s.p256dh,s.auth,o.attempts
      FROM notification_push_outbox o JOIN notification_events e ON e.id=o.event_id JOIN push_subscriptions s ON s.id=o.subscription_id
      JOIN notification_inbox n ON n.event_id=e.id AND n.user_id=s.user_id LEFT JOIN notification_settings p ON p.user_id=s.user_id
      WHERE o.event_id=?1 AND o.subscription_id=?2 AND o.status='sending' AND o.lease_until=?3
      AND s.disabled_at IS NULL AND COALESCE(p.push_enabled,1)=1 AND n.dismissed_at IS NULL AND n.read_at IS NULL
      AND e.created_at > ?4 AND ${notificationVisibleSql('s.user_id')}
      AND EXISTS (SELECT 1 FROM sessions session JOIN auth_accounts a ON a.user_id=session.user_id
        WHERE session.token_hash=s.session_hash AND session.user_id=s.user_id AND session.revoked_at IS NULL
        AND session.expires_at>?5 AND session.auth_method='password' AND a.password_hash IS NOT NULL)`)
      .bind(item.event_id,item.subscription_id,lease,new Date(Date.now()-86400_000).toISOString(),nowIso())
      .first<{ id: string; title: string; body: string; url: string; user_id: string; endpoint: string; p256dh: string; auth: string; attempts: number }>();
    let status: 'sent' | 'pending' | 'failed' | 'cancelled' = 'cancelled';
    if (row) {
      try {
        const sent = await sendWebPush(env, row, { title: row.title, body: row.body, data: { userId: row.user_id, notificationId: row.id, url: row.url } });
        if (sent.status >= 200 && sent.status < 300) status = 'sent';
        else if (sent.status === 404 || sent.status === 410) {
          await env.DB.prepare("UPDATE push_subscriptions SET disabled_at=?2,disabled_reason='expired',updated_at=?2 WHERE id=?1").bind(item.subscription_id,nowIso()).run();
        } else status = row.attempts >= 5 || (sent.status >= 300 && sent.status < 500 && sent.status !== 429) ? 'failed' : 'pending';
      } catch { status = row.attempts >= 5 ? 'failed' : 'pending'; }
    }
    await env.DB.prepare(`UPDATE notification_push_outbox SET status=?4,lease_until=NULL,available_at=?5,updated_at=?6
      WHERE event_id=?1 AND subscription_id=?2 AND lease_until=?3 AND status='sending'`)
      .bind(item.event_id,item.subscription_id,lease,status,new Date(Date.now()+Math.min(3600_000,30_000*2**(row?.attempts??0))).toISOString(),nowIso()).run();
  }
}
