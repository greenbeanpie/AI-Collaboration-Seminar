import { PageHeading } from '../components/ui';
import { useSession } from '../auth';
import { AdminAiRetries } from './AdminAiRetries';
import { AiDiagnosticsPanel } from './AiDiagnosticsPanel';
import { BackendCapabilitiesCard } from './BackendCapabilitiesCard';

export function SystemOverviewPage() {
  const session = useSession();
  return <div className="page-stack settings-page">
    <PageHeading eyebrow="网站管理" title="系统概况" detail="查看当前后端能力、上传限制与服务状态。" />
    <BackendCapabilitiesCard />
    {session.data?.isAdmin && <AdminAiRetries userId={session.data.id} superAdmin={session.data.role === 'super_admin'} onDenied={() => void session.refetch()} />}
    {session.data?.role === 'super_admin' && <AiDiagnosticsPanel />}
  </div>;
}
