import { useEffect, useState } from 'react';
import { Link, Navigate, Outlet, Route, Routes, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { ArrowUpRight, WifiOff } from 'lucide-react';
import { useCapabilities, useSession } from './auth';
import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';
import { CreateProjectPage } from './pages/CreateProjectPage';
import { AcceptInvitationPage } from './pages/AcceptInvitationPage';
import { AppShell } from './components/AppShell';
import { ProjectShell } from './components/ProjectShell';
import { ProjectOverviewPage } from './pages/ProjectOverviewPage';
import { AiWorkspacePage, ExportPage, LedgerPage, MaterialsPage, ProjectSettingsPage, RehearsalsPage, RequirementsPage, ReviewsPage, SourcesPage, TasksPage, TeamPage } from './pages/PlaceholderPages';
import { ErrorNotice, Spinner } from './components/ui';

function Landing() {
  const session = useSession();
  const capabilities = useCapabilities();
  if (session.isLoading) return <main className="center-screen"><Spinner label="正在恢复登录状态" /></main>;
  if (session.error) return <ServiceFailure error={session.error} retry={session.refetch} />;
  if (session.data) return <Navigate to="/app" replace />;
  return <LoginPage capabilities={capabilities.data} capabilityError={capabilities.error} onRetryCapabilities={capabilities.refetch} />;
}

function ServiceFailure({ error, retry }: { error: unknown; retry: () => unknown }) {
  return <main className="center-screen"><div className="welcome-card"><Brand /><h1>服务暂时无法连接</h1><p>登录和项目数据来自后端服务。请稍后重试，或检查部署状态。</p><ErrorNotice error={error} onRetry={() => { void retry(); }} /><div className="welcome-actions"><Link className="button button-primary" to="/">重试服务</Link><a className="button button-quiet" href="/guest/index.html">游客演示 <ArrowUpRight size={16} /></a></div></div></main>;
}

function Brand() {
  return <div className="brand brand-large"><div className="brand-mark">补</div><div><strong>补位</strong><small>AI 项目办公室</small></div></div>;
}

function ProtectedApp() {
  const session = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  useEffect(() => {
    const expired = () => { void queryClient.clear(); navigate('/login', { replace: true }); };
    window.addEventListener('auth-expired', expired);
    return () => window.removeEventListener('auth-expired', expired);
  }, [navigate, queryClient]);
  if (session.isLoading) return <main className="center-screen"><Spinner label="正在检查账户" /></main>;
  if (session.error) return <ServiceFailure error={session.error} retry={session.refetch} />;
  if (!session.data) return <Navigate to="/login" replace />;
  return <AppShell user={session.data}><Outlet /></AppShell>;
}

function PwaStatus() {
  const online = useStateOnline();
  const { needRefresh: [needRefresh], updateServiceWorker } = useRegisterSW();
  return <>
    {!online && <div className="offline-banner"><WifiOff size={15} /> 当前离线。已加载内容可查看，修改先保存在本机草稿，联网后由你确认提交。</div>}
    {needRefresh && <div className="update-banner">更新会重新载入页面，请先确认材料草稿已保存。<button className="button button-small button-primary" onClick={() => void updateServiceWorker(true)}>立即更新</button></div>}
  </>;
}

function useStateOnline(): boolean {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true); const off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  return online;
}

export default function App() {
  return <>
    <PwaStatus />
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/login" element={<LoginPage />} />
      <Route element={<ProtectedApp />}>
        <Route path="/app" element={<DashboardPage />} />
        <Route path="/app/projects/new" element={<CreateProjectPage />} />
        <Route path="/app/join" element={<AcceptInvitationPage />} />
        <Route path="/app/projects/:projectId" element={<ProjectShell />}>
          <Route index element={<ProjectOverviewPage />} />
          <Route path="sources" element={<SourcesPage />} />
          <Route path="requirements" element={<RequirementsPage />} />
          <Route path="team" element={<TeamPage />} />
          <Route path="tasks" element={<TasksPage />} />
          <Route path="ai" element={<AiWorkspacePage />} />
          <Route path="materials" element={<MaterialsPage />} />
          <Route path="reviews" element={<ReviewsPage />} />
          <Route path="rehearsals" element={<RehearsalsPage />} />
          <Route path="ledger" element={<LedgerPage />} />
          <Route path="settings" element={<ProjectSettingsPage />} />
          <Route path="export" element={<ExportPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  </>;
}
