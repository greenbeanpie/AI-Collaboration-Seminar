import { DateInput } from '../components/DateInput';
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
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: () => api.post<'ProjectResponse'>('/api/v1/projects', {
      name: name.trim(), description: description.trim(),
      ...(deadlineDate ? { deadlineDate, deadlinePrecision: 'date' } : { deadlinePrecision: 'unknown' }),
    }),
    onSuccess: async (project) => { await queryClient.invalidateQueries({ queryKey: ['projects'] }); navigate(`/app/projects/${project.id}`); },
  });
  return <div className="page-stack narrow-page">
    <Link className="back-link" to="/app"><ArrowLeft size={16} />返回项目列表</Link>
    <PageHeading eyebrow="新建项目" title="建立协作空间" detail="项目由真实账户创建，创建者将成为负责人。" />
    <form className="card form-card" onSubmit={(event) => { event.preventDefault(); create.mutate(); }}>
      <Field label="项目名称"><input className="input" required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：校园创新项目" /></Field>
      <Field label="项目说明" hint="可描述目标、背景或团队约定。"><textarea className="input textarea" maxLength={2000} rows={4} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="写下团队需要共同推进的目标……" /></Field>
      <Field label="截止日期" hint="仅填写通知中明确给出的日期；当前页面不录入具体时刻。"><DateInput className="input" type="date" value={deadlineDate} onChange={(event) => setDeadlineDate(event.target.value)} /></Field>
      <div className="form-note"><CalendarDays size={16} />未确认日期时会保留为空；有日期时按“精确到日期”保存，不会自动补上时间。</div>
      {create.error && <ErrorNotice error={create.error} />}
      <div className="form-actions"><Link to="/app" className="button button-quiet">取消</Link><button type="submit" className="button button-primary" disabled={create.isPending || !name.trim()}>{create.isPending ? '正在创建…' : '创建项目'}</button></div>
    </form>
  </div>;
}
