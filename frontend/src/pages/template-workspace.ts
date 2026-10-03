import type { TemplateDraft, TemplatePayload, TemplateTask, TemplateWorkspace } from '../api/project-templates';
import type { WizardGoal } from './project-wizard';

export type TemplateForm = { payload: TemplatePayload; goal: WizardGoal; tasks: TemplateTask[] };
export function templateFormFromDraft(draft: TemplateDraft): TemplateForm {
  const payload = structuredClone(draft.payload);
  payload.workspace ??= { templateId: 'blank', materials: [], standards: null };
  const goal = draft.previewState === 'ready' && draft.previewRevision === draft.revision ? draft.preview?.goal ?? payload.goal : payload.goal ?? draft.preview?.goal;
  return { payload, goal: structuredClone(goal ?? { title: '', detail: '' }), tasks: (draft.preview?.tasks ?? []).map(task => ({ ...structuredClone(task), key: task.key || crypto.randomUUID(), dependsOn: [...(task.dependsOn ?? [])] })) };
}
export function normalizedTemplate(form: TemplateForm): TemplateForm {
  const goal = { title: form.goal.title.trim() || form.payload.name.trim(), detail: form.goal.detail.trim() };
  const payload: TemplatePayload = { ...structuredClone(form.payload), name: form.payload.name.trim(), description: form.payload.description.trim(), inviteUsernames: form.payload.inviteUsernames.map(name => name.trim()).filter(Boolean), goal, workspace: { ...structuredClone(form.payload.workspace!), materials: form.payload.workspace!.materials.map(material => ({ ...material, title: material.title.trim() })), standards: form.payload.workspace!.standards ? { ...structuredClone(form.payload.workspace!.standards), title: form.payload.workspace!.standards.title.trim(), requirements: form.payload.workspace!.standards.requirements.map(requirement => ({ ...requirement, title: requirement.title.trim(), detail: requirement.detail.trim() })), weights: form.payload.workspace!.standards.weights.map(weight => ({ ...weight, label: weight.label.trim() })) } : null } };
  return { payload, goal, tasks: form.tasks.map(task => ({ ...structuredClone(task), title: task.title.trim(), detail: task.detail.trim(), criteria: task.criteria.trim() })) };
}
export function templateSignature(form: TemplateForm, files: Array<{ id: string }> = []): string { return JSON.stringify({ ...form, fileIds: files.map(file => file.id) }); }
export function sameTemplateValue(a: unknown, b: unknown): boolean {
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stable(item)])) : value;
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}
export function validateTemplateForm(form: TemplateForm): void {
  if (!form.payload.name.trim() || form.payload.name.length > 100) throw new Error('项目名称需要 1–100 个字符。');
  if (!Number.isInteger(form.payload.teamSize) || form.payload.teamSize < 1 || form.payload.teamSize > 100) throw new Error('计划组员人数需要是 1–100 的整数。');
  if (form.tasks.length > 20) throw new Error('任务最多 20 项。');
  const keys = new Set(form.tasks.map(task => task.key));
  if (keys.size !== form.tasks.length) throw new Error('任务标识重复，请重新读取或调整任务。');
  const tasks = new Map(form.tasks.map(task => [task.key, task]));
  const visited = new Set<string>(), visiting = new Set<string>();
  const visit = (key: string) => { if (visiting.has(key)) throw new Error('任务依赖存在循环，请调整前置关系。'); if (visited.has(key)) return; visiting.add(key); for (const dependency of tasks.get(key)?.dependsOn ?? []) { if (dependency === key || !keys.has(dependency)) throw new Error('前置任务必须是本预览中的其他任务。'); visit(dependency); } visiting.delete(key); visited.add(key); };
  for (const [index, task] of form.tasks.entries()) { if (!task.title.trim() || !task.criteria.trim()) throw new Error(`第 ${index + 1} 个任务需要标题和验收标准。`); if (!Number.isFinite(task.effortHours) || task.effortHours < .25 || task.effortHours > 200) throw new Error(`第 ${index + 1} 个任务的预计工时需要为 0.25–200 小时。`); visit(task.key); }
  const workspace: TemplateWorkspace = form.payload.workspace!;
  if (workspace.materials.length > 20) throw new Error('项目预览最多包含 20 份文档。');
  for (const [index, material] of workspace.materials.entries()) if (!material.title.trim()) throw new Error(`第 ${index + 1} 份文档需要标题。`);
  const standard = workspace.standards;
  if (!standard) return;
  if (!standard.title.trim()) throw new Error('请填写项目标准名称。');
  if (standard.requirements.length > 100 || standard.weights.length > 10) throw new Error('最多 100 条要求及 10 个评分维度。');
  const weightKeys = new Set(standard.weights.map(weight => weight.key));
  if (weightKeys.size !== standard.weights.length || standard.weights.some(weight => !weight.label.trim() || !Number.isFinite(weight.weight) || weight.weight < 0 || weight.weight > 100)) throw new Error('评分项需要名称和 0–100 的权重，且维度不能重复。');
  if (standard.weights.length && standard.weights.reduce((total, weight) => total + weight.weight, 0) <= 0) throw new Error('评分权重总和需要大于 0，也可以将全部要求保留为不计分的检查项。');
  if (standard.requirements.some(requirement => !requirement.title.trim() || (requirement.dimensionKey && !weightKeys.has(requirement.dimensionKey)))) throw new Error('请填写每条要求的标题，并保留其关联评分项。');
}
