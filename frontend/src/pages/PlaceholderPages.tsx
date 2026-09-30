import { EmptyState, PageHeading } from '../components/ui';

function Placeholder({ title, detail }: { title: string; detail: string }) {
  return <div className="page-stack"><PageHeading eyebrow="项目工作区" title={title} detail={detail} /><div className="card"><EmptyState title="正在接入项目服务" detail="此页面不展示演示数据。真实项目记录加载后会显示在这里。" /></div></div>;
}

export const SourcesPage = () => <Placeholder title="通知来源" detail="导入文件、粘贴原文或读取公开网页，并查看解析任务。" />;
export const RequirementsPage = () => <Placeholder title="要求与评分" detail="检查原文引用、修改提取结果并由负责人确认。" />;
export const TeamPage = () => <Placeholder title="团队" detail="查看成员技能、维护投入时间并管理项目邀请。" />;
export const TasksPage = () => <Placeholder title="任务工作台" detail="分配任务、跟踪状态并围绕任务讨论。" />;
export const AiWorkspacePage = () => <Placeholder title="AI 工作区" detail="根据后端能力状态发起草稿任务，并在人工复核后采纳。" />;
export const MaterialsPage = () => <Placeholder title="材料中心" detail="编辑项目材料并保留每个正式版本。" />;
export const ReviewsPage = () => <Placeholder title="预审" detail="按已确认要求和评分版本生成绑定材料版本的报告。" />;
export const RehearsalsPage = () => <Placeholder title="答辩演练" detail="按文字逐题练习并生成会话总结。" />;
export const LedgerPage = () => <Placeholder title="过程账本" detail="追踪决策、贡献、AI 使用与第三方资源声明。" />;
export const ProjectSettingsPage = () => <Placeholder title="项目设置" detail="更新项目基本信息并查看服务端能力限制。" />;
export const ExportPage = () => <Placeholder title="导出成果说明" detail="汇总材料、要求、过程记录与资源清单。" />;
