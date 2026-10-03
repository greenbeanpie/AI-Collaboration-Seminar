import { requestSettingsLeave } from '../dialogs/settings-leave';
import { BrandMark } from './BrandMark';
import { NotificationControls } from '../notifications/NotificationControls';
import { unsubscribeDevice, deviceSubscriptionId } from '../notifications/core';
import { notificationRequest } from '../notifications/api';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, BookOpen, FolderKanban, KeyRound, LifeBuoy, LogOut, MoreHorizontal, Plus, Search, Settings, UserRound, UsersRound } from 'lucide-react';
import { api } from '../api/client';
import type { User } from '../api/types';
import { clearAccountStorage } from '../storage';
import { ErrorNotice } from './ui';
import { ThemeSelector } from './ThemeSelector';
import { OfflineWorkspaceStatus } from '../offline/OfflineWorkspaceStatus';
import { forgetAccount } from '../offline/store';

export function AppShell({ user, children }: { user: User; children: ReactNode }) {
  const logoutLock = useRef(false);
  const [logoutError, setLogoutError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const accountControls = useRef<HTMLDivElement>(null);
  const accountMenuButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { setAccountMenuOpen(false); }, [pathname]);
  useEffect(() => {
    if (!accountMenuOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (document.querySelector('[data-page-dialog]')) return;
      if (event.target instanceof Node && !accountControls.current?.contains(event.target)) setAccountMenuOpen(false);
    };
    const closeEscape = (event: KeyboardEvent) => {
      if (document.querySelector('[data-page-dialog]')) return;
      if (event.key === 'Escape') { setAccountMenuOpen(false); accountMenuButton.current?.focus(); }
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeEscape);
    return () => { document.removeEventListener('pointerdown', closeOutside); document.removeEventListener('keydown', closeEscape); };
  }, [accountMenuOpen]);
  const queryClient = useQueryClient();
  const label = user.displayName || user.username || user.email || '项目成员';

  async function logout() {
    if (logoutLock.current) return;
    logoutLock.current = true;
    try {
      if (!await requestSettingsLeave()) return;
      setBusy(true); setLogoutError(null);
      if (navigator.onLine === false) {
        forgetAccount(); queryClient.clear(); navigate('/login', { replace: true }); return;
      }
      const subscriptionId = deviceSubscriptionId(user.id);
      await unsubscribeDevice(user.id,notificationRequest);
      await api.delete<'AuthSessionDeleteResponse'>('/api/v1/auth/session',{headers:{...(subscriptionId ? {'X-Push-Subscription-Id':subscriptionId} : {}),'X-Notification-Account':user.id}});
      clearAccountStorage(user.id);
      forgetAccount();
      await queryClient.clear();
      navigate('/login', { replace: true });
    } catch (error) { window.dispatchEvent(new Event('settings-leave-failed')); setLogoutError(error); }
    finally { logoutLock.current = false; setBusy(false); }
  }

  return <div className="app-frame office-shell">
    <aside className="sidebar">
      <div className="sidebar-brand"><Link to="/app" className="brand"><span className="brand-mark"><BrandMark/></span><span className="brand-copy"><strong>补位</strong><small>AI 项目办公室</small></span></Link></div>
      <div className="sidebar-navigation">
      <div className="nav-label">工作空间</div>
      <nav className="main-nav" aria-label="主导航">
        <NavLink to="/app" end className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}><FolderKanban size={18} />我的项目</NavLink>
        <NavLink to="/app/join" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}><UsersRound size={18} />加入项目</NavLink>
        <NavLink to="/app/support" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}><KeyRound size={18} />支持工单</NavLink>
        <NavLink to="/app/help" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}><BookOpen size={18} />帮助文档</NavLink>
        <NavLink to="/app/profile" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}><UserRound size={18} />个人资料</NavLink>
        <NavLink to="/app/settings" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}><Settings size={18} />设置</NavLink>
        <NavLink to="/app/people" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}><Search size={18} />搜索用户</NavLink>
      </nav>
      <Link className="sidebar-create" to="/app/projects/new"><Plus size={17} />新建项目</Link>
      <Link className="sidebar-archive" to="/app?archive=1" aria-haspopup="dialog"><Archive size={15} />查看归档任务</Link>
      </div>
      <div className="sidebar-spacer" />
      {logoutError !== null && <div className="sidebar-error"><ErrorNotice error={logoutError} /></div>}
      <div className="sidebar-note">登录账户的数据由项目服务保存</div>
    </aside>
    <div className="workspace-frame">
      <header className="workspace-topbar" aria-label="工作区顶栏">
        <span className="workspace-context">工作空间</span>
        <div className="workspace-top-actions" ref={accountControls}>
            <NotificationControls/>
          <Link className="topbar-account" to="/app/profile" aria-label={`个人资料：${label}`}><span className="avatar">{label.slice(0, 1).toLocaleUpperCase()}</span><span className="topbar-account-name">{label}</span></Link>
          <button ref={accountMenuButton} className="icon-button topbar-actions-toggle" type="button" aria-label="主题与账户操作" aria-expanded={accountMenuOpen} aria-controls="workspace-account-actions" onClick={() => setAccountMenuOpen(open => !open)}><MoreHorizontal size={20} /></button>
          <div id="workspace-account-actions" className="workspace-account-panel" data-open={accountMenuOpen}>
            <ThemeSelector/>
            <Link className="topbar-support" to="/app/support" aria-label="支持工单"><LifeBuoy size={17}/><span>支持</span></Link>
            <button className="icon-button topbar-logout" title="退出登录" aria-label="退出登录" disabled={busy} onClick={() => void logout()}><LogOut size={17} /><span className="topbar-action-label">退出登录</span></button>
          </div>
        </div>
      </header>
      <main className="main-shell">{(pathname === '/app' || pathname.startsWith('/app/projects/')) && <OfflineWorkspaceStatus key={user.id} accountId={user.id}/>} {children}</main>
    </div>
  </div>;
}
