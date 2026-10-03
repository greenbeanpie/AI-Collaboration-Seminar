import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, projectPath } from '../api/client';
import { ErrorNotice, Field, SectionCard, Spinner } from '../components/ui';
const labels: Record<string, string> = {
  pending: '待处理', accepted: '已接受', declined: '已拒绝', revoked: '已撤销', expired: '已过期'
};
export function ReceivedInvitations() {
  const client = useQueryClient(), [offset, setOffset] = useState(0);
  const query = useQuery({
    queryKey: ['username-invitations', 'inbox', offset], queryFn: () => api.get<'UsernameInvitationListResponse'>('/api/v1/invitations/inbox', {
      offset
    }), staleTime: 15000, refetchOnWindowFocus: true
  });
  const handle = useMutation({
    mutationFn: ({ id, action }: {
      id: string;
      action: 'accept' | 'decline';
    }) => api.post<'UsernameInvitationActionResponse'>(`/api/v1/invitations/inbox/${id}`, {
      action
    }), onSuccess: async () => {
      await client.invalidateQueries({
        queryKey: ['username-invitations']
      });
      await client.invalidateQueries({
        queryKey: ['projects']
      });
      await client.invalidateQueries({
        queryKey: ['notifications']
      });
    }
  });
  return <SectionCard title="收到的项目邀请" detail="接受后加入普通成员；待处理邀请不预占人数，名额先到先成功。">{query.isLoading && <Spinner label="正在读取项目邀请" />}{query.error && <ErrorNotice error={query.error} onRetry={() => void query.refetch()}/>} {handle.error && <ErrorNotice error={handle.error}/>} {query.data?.items.length === 0 && <p>暂无项目邀请。</p>} {query.data?.items.map(invite => <article className="callout" key={invite.id}><strong>{invite.projectName}</strong><p>{invite.inviterName} 邀请你成为组员 · {labels[invite.status]} · 有效至 {new Date(invite.expiresAt).toLocaleDateString('zh-CN')}</p>{invite.status === 'pending' && <div className="form-actions"><button className="button button-primary button-small" disabled={handle.isPending} onClick={() => handle.mutate({
    id: invite.id, action: 'accept'
  })}>接受邀请</button><button className="button button-quiet button-small" disabled={handle.isPending} onClick={() => handle.mutate({
    id: invite.id, action: 'decline'
  })}>拒绝邀请</button></div>}</article>)}<div className="form-actions">{offset > 0 && <button className="button button-quiet button-small" onClick={() => setOffset(n => Math.max(0, n - 20))}>上一页邀请</button>}{query.data?.nextOffset !== null && query.data?.nextOffset !== undefined && <button className="button button-quiet button-small" onClick={() => setOffset(query.data!.nextOffset!)}>下一页邀请</button>}</div></SectionCard>;
}
export function SentUsernameInvitations({ projectId }: {
  projectId: string;
}) {
  const client = useQueryClient(), [username, setUsername] = useState(''), [offset, setOffset] = useState(0), intent = useRef({
    username: '', key: crypto.randomUUID()
  });
  const query = useQuery({
    queryKey: ['username-invitations', projectId, offset], queryFn: () => api.get<'UsernameInvitationListResponse'>(projectPath(projectId, '/username-invitations'), {
      offset
    })
  });
  const send = useMutation({
    mutationFn: () => {
      const typed = username.trim();
      if (typed !== intent.current.username) {
        intent.current = {
          username: typed, key: crypto.randomUUID()
        };
      }
      return api.post<'UsernameInvitationCreateResponse'>(projectPath(projectId, '/username-invitations'), {
        username: typed
      }, {
        idempotencyKey: intent.current.key
      });
    }, onSuccess: async () => {
      setUsername('');
      intent.current = {
        username: '', key: crypto.randomUUID()
      };
      await client.invalidateQueries({
        queryKey: ['username-invitations', projectId]
      });
    }
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.post<'UsernameInvitationActionResponse'>(projectPath(projectId, `/username-invitations/${id}/revoke`)), onSuccess: () => client.invalidateQueries({
      queryKey: ['username-invitations', projectId]
    })
  });
  return <SectionCard title="按用户名邀请组员" detail="输入对方的完整登录用户名。对方在首页接受或拒绝；接受后才有项目权限。"><form className="stack" onSubmit={e => {
    e.preventDefault();
    send.mutate();
  }}><Field label="完整用户名"><input className="input" required maxLength={64} value={username} onChange={e => setUsername(e.target.value)} disabled={send.isPending}/></Field><button type="submit" className="button button-primary" disabled={!username.trim() || send.isPending}>发送项目邀请</button></form>{query.error && <ErrorNotice error={query.error}/>} {send.error && <ErrorNotice error={send.error}/>} {revoke.error && <ErrorNotice error={revoke.error}/>} {query.data?.items.map(invite => <div className="callout" key={invite.id}><strong>{invite.username}</strong> · {labels[invite.status]} {invite.status === 'pending' && <button className="button button-quiet button-small" disabled={revoke.isPending} onClick={() => revoke.mutate(invite.id)}>撤销邀请</button>}</div>)}<div className="form-actions">{offset > 0 && <button className="button button-quiet button-small" onClick={() => setOffset(n => Math.max(0, n - 20))}>上一页</button>}{query.data?.nextOffset != null && <button className="button button-quiet button-small" onClick={() => setOffset(query.data!.nextOffset!)}>下一页</button>}</div></SectionCard>;
}
