import type { DataOf } from '../api/types';

export function InvitationPreview({ project, pending, onConfirm, onCancel }: {
  project: DataOf<'InvitationPreviewResponse'>;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return <section className="callout" aria-label="邀请项目详情">
    <h3>{project.projectName}</h3>
    <h4>项目介绍</h4><p style={{ whiteSpace: 'pre-wrap' }}>{project.description.trim() || '尚未填写'}</p>
    <h4>项目主目标</h4><p>{project.goal.title.trim() || '尚未填写'}</p>
    <h4>目标说明</h4><p style={{ whiteSpace: 'pre-wrap' }}>{project.goal.detail.trim() || '尚未填写'}</p>
    <p className="muted">确认后将加入项目。查看详情不会加入项目或占用邀请次数。</p>
    <div className="form-actions"><button type="button" className="button button-quiet" disabled={pending} onClick={onCancel}>取消预览</button><button type="button" className="button button-primary" disabled={pending} onClick={onConfirm}>{pending ? '正在加入…' : '确认接受并加入'}</button></div>
  </section>;
}
