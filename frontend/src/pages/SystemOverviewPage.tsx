import { PageHeading } from '../components/ui';
import { BackendCapabilitiesCard } from './BackendCapabilitiesCard';

export function SystemOverviewPage() {
  return <div className="page-stack settings-page">
    <PageHeading eyebrow="网站管理" title="系统概况" detail="查看当前后端能力、上传限制与服务状态。" />
    <BackendCapabilitiesCard />
  </div>;
}
