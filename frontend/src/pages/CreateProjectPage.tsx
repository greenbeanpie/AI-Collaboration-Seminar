import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, CalendarDays } from 'lucide-react';
import { api } from '../api/client';
import { ErrorNotice, Field, PageHeading } from '../components/ui';

export function CreateProjectPage() {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [deadlineDate, setDeadlineDate] = useState('');
  const [deadlinePrecision, setDeadlinePrecision] = useState<'date' | 'datetime' | 'unknown'>('unknown');
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: () => api.post<'ProjectResponse'>('/api/v1/projects', {
      name: name.trim(), description: description.trim(),
      ...(deadlineDate ? { deadlineDate, deadlinePrecision } : { deadlinePrecision: 'unknown' }),
    }),
    onSuccess: async (project) => { await queryClient.invalidateQueries({ queryKey: ['projects'] }); navigate(`/app/projects/${project.id}`); },
  });
  return <div className="page-stack narrow-page">
    <Link className="back-link" to="/app"><ArrowLeft size={16} />返回项目列表</Link>
    <PageHeading eyebrow="新建项目" title="建立协作空间" detail="项目由真实账户创建，创建者将成为负责人。" />
    <form className="card form-card" onSubmit={(event) => { event.preventDefault(); create.mutate(); }}>
      <Field label="项目名称"><input className="input" required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：校园创新项目" /></Field>
      <Field label="项目说明" hint="可描述目标、背景或团队约定。"><textarea className="input textarea" maxLength={2000} rows={4} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="写下团队需要共同推进的目标……" /></Field>
      <div className="form-grid-two"><Field label="截止日期"><input className="input" type="date" value={deadlineDate} onChange={(event) => { setDeadlineDate(event.target.value); setDeadlinePrecision(event.target.value ? 'date' : 'unknown'); }} /></Field><Field label="日期精度"><select className="input" value={deadlinePrecision} onChange={(event) => setDeadlinePrecision(event.target.value as typeof deadlinePrecision)}><option value="unknown">尚未确认</option><option value="date">仅日期</option><option value="datetime">精确到时刻</option></select></Field></div>
      <div className="form-note"><CalendarDays size={16} />尚未确认的截止日期会保留为空，不会自动补上时间。</div>
      {create.error && <ErrorNotice error={create.error} />}
      <div className="form-actions"><Link to="/app" className="button button-quiet">取消</Link><button type="submit" className="button button-primary" disabled={create.isPending || !name.trim()}>{create.isPending ? '正在创建…' : '创建项目'}</button></div>
    </form>
  </div>;
}
