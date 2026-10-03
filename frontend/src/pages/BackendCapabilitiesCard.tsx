import { AlertTriangle } from 'lucide-react';
import { useCapabilities } from '../auth';
import { ErrorNotice, SectionCard, StatusPill } from '../components/ui';

export function BackendCapabilitiesCard() {
  const capabilities = useCapabilities();
  return (
    <SectionCard title="后端能力与限制" detail="上传限制、AI 可用性和比赛模板由公开 capabilities 接口返回。">
      {capabilities.error && <ErrorNotice error={capabilities.error} onRetry={() => void capabilities.refetch()} />}
      {capabilities.data ? <div className="capability-grid">
        <div className="capability-row"><span>环境</span><strong>{capabilities.data.environment}</strong></div>
        <div className="capability-row"><span>API 版本</span><strong>{capabilities.data.apiVersion}</strong></div>
        <div className="capability-row"><span>AI 服务</span><StatusPill tone={capabilities.data.features.aiEnabled ? 'good' : 'warn'}>{capabilities.data.features.aiEnabled ? '已启用' : '暂未启用'}</StatusPill></div>
        <div className="capability-row"><span>网页抓取</span><strong>{capabilities.data.features.webFetch ? '可用' : '未启用'}</strong></div>
        <div className="capability-row"><span>邮箱验证码模式</span><strong>{capabilities.data.features.emailMode}</strong></div>
        <div className="capability-row"><span>文件大小上限</span><strong>{(capabilities.data.limits.maxFileBytes / (1024 * 1024)).toFixed(0)} MiB</strong></div>
        <div className="capability-row"><span>PDF 页数上限</span><strong>{capabilities.data.limits.maxPdfPages} 页</strong></div>
        <div className="capability-row"><span>扫描页长边</span><strong>{capabilities.data.limits.pageImageMaxEdge} px</strong></div>
        <div className="capability-row"><span>单页图片上限</span><strong>{(capabilities.data.limits.pageImageMaxBytes / (1024 * 1024)).toFixed(1)} MiB</strong></div>
        <div className="capability-row"><span>AI 并发上限</span><strong>{capabilities.data.limits.concurrentAiTasksPerProject} 项 / 项目</strong></div>
        <div className="capability-row"><span>项目人数</span><strong>{capabilities.data.competitionTemplate.teamSizeLimit == null ? '不设上限' : `${capabilities.data.competitionTemplate.teamSizeLimit} 人`}</strong></div>
      </div> : !capabilities.error && <div className="callout">正在读取后端能力……</div>}
      {capabilities.data?.features.emailMode === 'echo' && capabilities.data.environment === 'local' && <div className="notice notice-warn"><AlertTriangle size={16} /><div className="notice-copy"><strong>本地邮箱回显模式</strong><small>仅本地联调会返回开发验证码；部署环境必须使用真实邮件服务。</small></div></div>}
      <div className="form-note"><AlertTriangle size={16} />官方申报书、签字承诺及正式提交仍以比赛平台为准；本工具中的预审与评分建议不是官方评审结果。</div>
    </SectionCard>
  );
}
