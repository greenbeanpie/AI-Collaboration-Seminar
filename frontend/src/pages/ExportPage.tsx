import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Download, FileJson2, RefreshCw } from 'lucide-react';
import { api, projectPath } from '../api/client';
import { useProject } from '../components/ProjectShell';
import { ErrorNotice, PageHeading, SectionCard, Spinner, StatusPill } from '../components/ui';

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function markdownValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function bundleToMarkdown(bundle: JsonObject): string {
  const project = asObject(bundle.project);
  const lines = [
    `# ${readString(project?.name) ?? '项目成果说明'}`,
    '',
    `导出时间：${readString(bundle.generatedAt) ?? '服务端未提供'}`,
    '',
    '> 本导出用于团队整理和过程留档，不构成赛事官方审核结果或正式提交。',
    '',
    '## 项目概况',
    '',
    markdownValue(project ?? {}),
    '',
    '## 项目主目标',
    '',
    markdownValue(bundle.mainGoal ?? {}),
  ];

  const sections: Array<[string, string]> = [
    ['材料及当前版本', 'materials'],
    ['要求集及确认状态', 'requirementSets'],
    ['任务', 'tasks'],
    ['任务依赖', 'taskDependencies'],
    ['历史任务链接', 'taskLinks'],
    ['任务提交与验收历史', 'taskSubmissions'],
    ['统一项目标准版本', 'standardsVersions'],
    ['独立评分与历史反馈', 'assessments'],
    ['历史检查依据与报告', 'legacyReviews'],
    ['导入资料', 'sources'],
    ['资料固定版本', 'sourceVersions'],
    ['成果固定版本', 'materialVersions'],
    ['答辩冻结问答', 'rehearsalTurns'],
    ['评分标准版本', 'rubricVersions'],
    ['近期过程事件', 'events'],
  ];

  for (const [title, key] of sections) {
    const items = asArray(bundle[key]);
    lines.push('', `## ${title}`, '');
    if (!items.length) {
      lines.push('暂无记录。');
      continue;
    }
    items.forEach((item, index) => {
      const record = asObject(item);
      lines.push(`### ${index + 1}. ${readString(record?.title) ?? readString(record?.name) ?? `${title}记录`}`, '', '```json', JSON.stringify(item, null, 2), '```');
      const material = record && key === 'materials' ? readString(record.markdown) : null;
      if (material) lines.push('', '材料正文：', '', material);
      lines.push('');
    });
  }

  lines.push('## AI 使用摘要', '', markdownValue(bundle.aiUsage ?? '服务端未提供 AI 使用摘要。'), '');
  return lines.join('\n');
}

function downloadFile(fileName: string, content: string, mime: string) {
  const url = URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function ExportPage() {
  const { projectId, project } = useProject();
  const [showPreview, setShowPreview] = useState(false);
  const query = useQuery({
    queryKey: ['export-bundle', projectId],
    queryFn: () => api.get<'ExportBundleResponse'>(projectPath(projectId, '/export-bundle')),
    staleTime: 0,
    retry: false,
  });
  const bundle = asObject(query.data);
  const markdown = bundle ? bundleToMarkdown(bundle) : '';
  const baseName = (project.name || '项目成果').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 80) || '项目成果';

  return <div className="page-stack export-page">
    <PageHeading eyebrow="成果整理" title="导出成果说明" detail="从当前项目服务端数据生成 JSON 汇总和 Markdown 整理稿。刷新可重新读取最新版本。" action={<StatusPill tone={bundle ? 'good' : 'neutral'}>{bundle ? '已读取服务端汇总' : '等待服务端数据'}</StatusPill>} />

    {query.isLoading && <Spinner label="正在从后端整理项目记录" />}
    {query.error && <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />}
    {bundle && <>
      <SectionCard title="服务端汇总" detail={`生成于 ${readString(bundle.generatedAt) ?? '服务端未提供时间'}`} action={<button className="button button-quiet button-small" onClick={() => void query.refetch()} disabled={query.isFetching}><RefreshCw size={14} />{query.isFetching ? '刷新中' : '刷新数据'}</button>}>
        <div className="export-summary-grid">{[
          ['材料', 'materials'], ['要求集及状态', 'requirementSets'], ['任务', 'tasks'], ['依赖关系', 'taskDependencies'], ['任务提交与验收', 'taskSubmissions'], ['统一标准版本', 'standardsVersions'], ['独立评分记录', 'assessments'], ['导入资料', 'sources'], ['来源版本', 'sourceVersions'], ['成果版本', 'materialVersions'], ['答辩问答', 'rehearsalTurns'], ['评分维度版本', 'rubricVersions'], ['过程事件', 'events'],
        ].map(([label, key]) => <div className="export-summary-item" key={key}><span>{label}</span><strong>{asArray(bundle[key]).length}</strong></div>)}</div>
        <div className="button-row"><button className="button button-primary" onClick={() => downloadFile(`${baseName}-成果说明.md`, markdown, 'text/markdown')}><Download size={15} />下载 Markdown</button><button className="button button-quiet" onClick={() => downloadFile(`${baseName}-服务端汇总.json`, JSON.stringify(bundle, null, 2), 'application/json')}><FileJson2 size={15} />下载 JSON 原始数据</button><button className="button button-quiet" onClick={() => setShowPreview((value) => !value)}>{showPreview ? '收起预览' : '预览 Markdown'}</button></div>
        {showPreview && <pre className="export-preview">{markdown}</pre>}
      </SectionCard>
      <p className="data-origin-note"><span className="origin-dot" />材料、要求集、rubric、任务和账本均按当前 API 汇总；服务端缺少的数据不会由前端补造。</p>
    </>}
  </div>;
}
