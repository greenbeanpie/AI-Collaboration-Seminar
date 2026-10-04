import { Suspense } from 'react';
import { Spinner } from '../components/ui';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useSession } from '../auth';
import { SettingsEditGuard } from './SettingsEditGuard';
import './SettingsLayout.css';

export function SettingsLayout() {
  const session = useSession();
  const location = useLocation();
  const tabs = [['profile', '账户信息'], ['security', '账户安全'], ['appearance', '外观'], ['installation', '安装应用'], ['agent-bridges', '本地 Agent'], ['notifications', '推送与通知']];
  if (session.data?.isAdmin === true) {
    tabs.push(['accounts', '账户管理'], ['system', '系统概况']);
    if (session.data.role === 'super_admin') tabs.push(['ai', 'AI 配置']);
  }
  return <div className="settings-layout">
    <h1>设置</h1>
    <nav className="settings-tabs" aria-label="设置分类">{tabs.map(([path, label]) => <NavLink key={path} to={`/app/settings/${path}`}>{label}</NavLink>)}</nav>
    <SettingsEditGuard><div key={location.pathname} className="settings-content"><Suspense fallback={<Spinner label="正在打开设置内容" />}><Outlet /></Suspense></div></SettingsEditGuard>
  </div>;
}
