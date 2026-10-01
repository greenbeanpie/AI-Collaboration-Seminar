import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { FolderKanban, KeyRound, LogOut, Plus, Search, Settings, UsersRound } from 'lucide-react';
import { api } from '../api/client';
import type { User } from '../api/types';
import { clearAccountStorage } from '../storage';
import { ErrorNotice } from './ui';

export function AppShell({ user, children }: { user: User; children: ReactNode }) {
  const [logoutError, setLogoutError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const label = user.displayName || user.username || user.email || '项目成员';

  async function logout() {
    if (!window.dispatchEvent(new Event('settings-before-leave', { cancelable: true }))) return;
    setBusy(true); setLogoutError(null);
    try {
      await api.delete<'AuthSessionDeleteResponse'>('/api/v1/auth/session');
      clearAccountStorage(user.id);
      await queryClient.clear();
      navigate('/login', { replace: true });
    } catch (error) { window.dispatchEvent(new Event('settings-leave-failed')); setLogoutError(error); }
    finally { setBusy(false); }
  }

  return <div className="app-frame">
    <aside className="sidebar">
      <Link to="/app" className="brand"><span className="brand-mark">补</span><span className="brand-copy"><strong>补位</strong><small>AI 项目办公室</small></span></Link>
      <div className="nav-label">工作空间</div>
      <nav className="main-nav" aria-label="主导航">
        <NavLink to="/app" end className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}><FolderKanban size={18} />我的项目</NavLink>
        <NavLink to="/app/join" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}><UsersRound size={18} />加入项目</NavLink>
        <NavLink to="/app/support" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}><KeyRound size={18} />支持工单</NavLink>
        <NavLink to="/app/settings" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}><Settings size={18} />设置</NavLink>
        <NavLink to="/app/people" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}><Search size={18} />搜索用户</NavLink>
      </nav>
      <Link className="sidebar-create" to="/app/projects/new"><Plus size={17} />新建项目</Link>
      <div className="sidebar-spacer" />
      {logoutError !== null && <div className="sidebar-error"><ErrorNotice error={logoutError} /></div>}
      <div className="profile-row"><span className="avatar">{label.slice(0, 1).toLocaleUpperCase()}</span><span className="profile-info"><strong>{label}</strong><small>{user.username || user.email || (user.isAdmin ? '系统管理员' : '协作账户')}</small></span><button className="icon-button" title="退出登录" aria-label="退出登录" disabled={busy} onClick={() => void logout()}><LogOut size={17} /></button></div>
      <div className="sidebar-note">登录账户的数据由项目服务保存</div>
    </aside>
    <main className="main-shell"><div className="mobile-bar"><Link to="/app" className="brand"><span className="brand-mark">补</span><strong>补位</strong></Link><span>{label}</span></div>{children}</main>
  </div>;
}
