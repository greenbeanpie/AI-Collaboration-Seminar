import type { EventItem } from '../api/types';

const statusNames: Record<string, string> = { todo: '待开始', doing: '进行中', done: '已完成' };

export function presentEvent(event: Pick<EventItem, 'type' | 'payload' | 'actorType'>) {
  const payload = event.payload ?? {};
  const revision = typeof payload.revision === 'number' ? `，版本 r${payload.revision}` : '';
  const actor = event.actorType === 'ai' ? 'AI 辅助' : event.actorType === 'system' ? '系统记录' : '成员操作';
  switch (event.type) {
    case 'decision.recorded': return { title: '记录团队决策', detail: typeof payload.title === 'string' ? payload.title : '已保存一条团队决策。', actor };
    case 'material.saved': return { title: '保存材料版本', detail: `成员已保存材料${revision}。`, actor };
    case 'material.adopted': return { title: '采纳 AI 材料', detail: `成员确认后已保存正式材料${revision}。`, actor };
    case 'task.status_changed': {
      const from = typeof payload.from === 'string' ? statusNames[payload.from] : undefined;
      const to = typeof payload.to === 'string' ? statusNames[payload.to] : undefined;
      return { title: '更新任务状态', detail: from && to ? `${from} → ${to}` : '任务状态已更新，请在任务页查看。', actor };
    }
    case 'task.assignment_applied': return { title: '更新任务分工', detail: '成员已确认任务负责人，请在任务页查看。', actor };
    case 'assignment.suggestions_created': return { title: '生成分工建议', detail: 'AI 建议已生成，等待成员逐项确认。', actor };
    case 'ai.run_succeeded': return { title: '完成 AI 辅助任务', detail: '结果已生成，仍需人工复核后采纳。', actor };
    case 'review.succeeded': return { title: '完成材料预审', detail: '预审结果已生成，请在预审页查看。', actor };
    case 'rehearsal.finished': return { title: '完成答辩演练', detail: '演练记录已保存，请在答辩演练页查看。', actor };
    default: return { title: '项目活动', detail: '已记录一项项目活动。完整记录可随项目导出。', actor };
  }
}
