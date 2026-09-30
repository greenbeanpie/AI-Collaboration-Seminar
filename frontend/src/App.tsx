import { ThemeSelector } from './components/ThemeSelector';
import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from 'react';
import { Link, Navigate, Outlet, Route, Routes, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { ArrowUpRight, WifiOff } from 'lucide-react';
import { useCapabilities, useSession } from './auth';
import { AppShell } from './components/AppShell';
import { ProjectShell } from './components/ProjectShell';
import { ErrorNotice, Spinner } from './components/ui';
import { getInstallState, promptInstall, subscribe } from './pwa-install';

const SupportTicketsPage = lazy(() => import('./pages/SupportTicketsPage').then(module => ({ default: module.SupportTicketsPage })));
const SupportTicketDetailPage = lazy(() => import('./pages/SupportTicketsPage').then(module => ({ default: module.SupportTicketDetailPage })));
const AccountSettingsPage = lazy(() => import('./pages/AccountSettingsPage').then(module => ({ default: module.AccountSettingsPage })));
const AdminAccountsPage = lazy(() => import('./pages/AdminAccountsPage').then(module => ({ default: module.AdminAccountsPage })));
const AiSettings = lazy(() => import('./pages/AiSettings').then(module => ({ default: module.AiSettings })));
const LoginPage = lazy(() => import('./pages/LoginPage').then((module) => ({ default: module.LoginPage })));
const DashboardPage = lazy(() => import('./pages/DashboardPage').then((module) => ({ default: module.DashboardPage })));
const CreateProjectPage = lazy(() => import('./pages/CreateProjectPage').then((module) => ({ default: module.CreateProjectPage })));
const AcceptInvitationPage = lazy(() => import('./pages/AcceptInvitationPage').then((module) => ({ default: module.AcceptInvitationPage })));
const ProjectOverviewPage = lazy(() => import('./pages/ProjectOverviewPage').then((module) => ({ default: module.ProjectOverviewPage })));
const SourcesPage = lazy(() => import('./pages/SourcesPage').then((module) => ({ default: module.SourcesPage })));
const RequirementsPage = lazy(() => import('./pages/RequirementsPage').then((module) => ({ default: module.RequirementsPage })));
const TasksPage = lazy(() => import('./pages/TasksPage').then((module) => ({ default: module.TasksPage })));
const MaterialsPage = lazy(() => import('./pages/MaterialsPage').then((module) => ({ default: module.MaterialsPage })));
const AiWorkspacePage = lazy(() => import('./pages/AiWorkspacePage').then((module) => ({ default: module.AiWorkspacePage })));
const ReviewsPage = lazy(() => import('./pages/ReviewsPage').then((module) => ({ default: module.ReviewsPage })));
const RehearsalsPage = lazy(() => import('./pages/RehearsalsPage').then((module) => ({ default: module.RehearsalsPage })));
const TeamPage = lazy(() => import('./pages/TeamPage').then((module) => ({ default: module.TeamPage })));
const LedgerPage = lazy(() => import('./pages/LedgerPage').then((module) => ({ default: module.LedgerPage })));
const ProjectSettingsPage = lazy(() => import('./pages/ProjectSettingsPage').then((module) => ({ default: module.ProjectSettingsPage })));
const ExportPage = lazy(() => import('./pages/ExportPage').then((module) => ({ default: module.ExportPage })));

function RouteLoading() {
  return <main className="center-screen"><Spinner label="正在打开工作区" /></main>;
}

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

function SystemAdminOnly({ superOnly = false }: { superOnly?: boolean }) {
  const session = useSession();
  if (superOnly && session.data?.role !== 'super_admin') return <div className="welcome-card"><h1>需要超级管理员权限</h1><p role="alert">系统配置仅限超级管理员。</p><Link to="/app">返回我的项目</Link></div>;
  if (session.data?.isAdmin !== true) return <div className="welcome-card"><h1>需要系统管理员权限</h1><p role="alert">项目负责人不能管理系统账户或模型配置。</p><Link to="/app">返回我的项目</Link></div>;
  return <Outlet />;
}

function PwaStatus() {
  const online = useStateOnline();
  const { needRefresh: [needRefresh], updateServiceWorker } = useRegisterSW();
  return <>
    {!online && <div className="offline-banner"><WifiOff size={15} /> 当前离线。已加载内容可能仍可查看；只有页面明确标示的本机草稿会在此设备保留，联网后请检查并确认提交。</div>}
    {needRefresh && <div className="update-banner">更新会重新载入页面，请先确认材料草稿已保存。<button className="button button-small button-primary" onClick={() => void updateServiceWorker(true)}>立即更新</button></div>}
    <PwaInstallBanner />
  </>;
}

function PwaInstallBanner() {
  const { canInstall } = useSyncExternalStore(subscribe, getInstallState);
  if (!canInstall) return null;
  return <div className="install-banner">安装到桌面可获得独立窗口和离线入口。<button className="button button-quiet button-small" onClick={() => void promptInstall()}>安装到桌面</button></div>;
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
    <ThemeSelector />
    <PwaStatus />
    <Suspense fallback={<RouteLoading />}><Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/login" element={<LoginPage />} />
      <Route element={<ProtectedApp />}>
        <Route path="/app" element={<DashboardPage />} />
        <Route path="/app/support" element={<SupportTicketsPage />} />
        <Route path="/app/support/:ticketId" element={<SupportTicketDetailPage />} />
        <Route path="/app/settings" element={<AccountSettingsPage />} />
        <Route element={<SystemAdminOnly />}>
          <Route path="/app/admin/accounts" element={<AdminAccountsPage />} />
          <Route element={<SystemAdminOnly superOnly />}><Route path="/app/admin/ai" element={<div className="page-stack ai-settings-page"><AiSettings /></div>} /></Route>
        </Route>
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
    </Routes></Suspense>
  </>;
}
