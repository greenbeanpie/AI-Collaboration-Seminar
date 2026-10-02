import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, listAllItems, projectPath } from '../api/client';
import { ErrorNotice } from './ui';
export type Contributor = { userId: string; displayName: string };
export function ContributorNames({ contributors }: { contributors?: Contributor[] }) {
  return <span>贡献归属：{contributors?.length ? contributors.map(person => person.displayName || person.userId.slice(0, 8)).join('、') : '未标记'}</span>;
}
export function FileContributorPicker({ projectId, value, onChange, disabled = false }: {
  projectId: string; value: string[] | undefined; onChange: (ids: string[]) => void; disabled?: boolean;
}) {
  const members = useQuery({ queryKey: ['members', projectId], queryFn: () => listAllItems<'MemberListResponse'>(projectPath(projectId, '/members')) });
  const me = useQuery({ queryKey: ['member', projectId, 'me'], queryFn: () => api.get<'MemberResponse'>(projectPath(projectId, '/members/me')) });
  const all = members.data ?? [];
  const selected = value ?? (me.data ? [me.data.userId] : []);
  const checkbox = useRef<HTMLInputElement>(null);
  useEffect(() => { if (checkbox.current) checkbox.current.indeterminate = selected.length > 0 && selected.length < all.length; }, [selected.length, all.length]);
  return <fieldset disabled={disabled || members.isLoading || me.isLoading} className="stack">
    <legend>组员贡献归属（可多选）</legend>
    <label className="checkbox-row"><input ref={checkbox} type="checkbox" checked={all.length > 0 && all.every(person => selected.includes(person.userId))} onChange={event => onChange(event.target.checked ? all.map(person => person.userId) : [])} />全选组员</label>
    {all.map(person => <label className="checkbox-row" key={person.userId}><input type="checkbox" checked={selected.includes(person.userId)} onChange={event => onChange(event.target.checked ? [...selected, person.userId] : selected.filter(id => id !== person.userId))} />{person.displayName || person.username || person.userId.slice(0, 8)}</label>)}
    {(members.error || me.error) && <ErrorNotice error={members.error || me.error} onRetry={() => { void members.refetch(); void me.refetch(); }} />}
    {value?.length === 0 && <p role="alert">请至少选择一位贡献成员。</p>}
  </fieldset>;
}
