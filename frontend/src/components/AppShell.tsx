import { requestSettingsLeave } from '../dialogs/settings-leave';
import { BrandMark } from './BrandMark';
import { NotificationControls } from '../notifications/NotificationControls';
import { unsubscribeDevice, deviceSubscriptionId, deviceKey, notifyWorkerAccount } from '../notifications/core';
import { notificationRequest } from '../notifications/api';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, BookOpen, FolderKanban, KeyRound, LifeBuoy, LogOut, MoreHorizontal, Plus, Search, Settings, UserRound, UsersRound } from 'lucide-react';
import { api } from '../api/client';
import type { User } from '../api/types';
import { clearAccountStorage } from '../storage';
import { ErrorNotice, Modal } from './ui';
import { ThemeSelector } from './ThemeSelector';
import { OfflineWorkspaceStatus } from '../offline/OfflineWorkspaceStatus';
import { clearOfflineAccount, forgetAccount, operations } from '../offline/store';
import { AiReferencePreferencesProvider } from './AiReferencePreferencesProvider';
import { setDesktopAccount } from '../desktop/lifecycle';
import { desktopInvoke, isDesktop } from '../desktop/bridge';
import { confirmPage } from '../dialogs/dialog-service';

export function AppShell({ user, children }: { user: User; children: ReactNode }) {
  useEffect(() => { setDesktopAccount(user.id); return () => setDesktopAccount(null); }, [user.id]);
  const logoutLock = useRef(false);
  const sessionRevoked = useRef(false);
  const [clearCount, setClearCount] = useState<number | null>(null);
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

  async function offerClearLogout() {
    if (busy) return;
    try { setLogoutError(null); setClearCount((await operations(user.id)).length); }
    catch (error) { setLogoutError(error); }
  }
  async function logout(clearDevice = false) {
    if (logoutLock.current) return;
    logoutLock.current = true;
    try {
      if (!await requestSettingsLeave()) return;
      if (isDesktop()) {
        const [pending, native] = await Promise.all([operations(user.id), desktopInvoke<{ pendingUploads: number }>('desktop_pending_files')]);
        if ((pending.length || native.pendingUploads) && !await confirmPage(`本机还有 ${pending.length} 项待同步操作、${native.pendingUploads} 个待上传附件。退出登录会停止同步，内容保留供原账户下次登录继续。确定退出吗？`)) return;
      }
      setBusy(true); setLogoutError(null);
      const offline = navigator.onLine === false;
      if (!offline && !sessionRevoked.current) {
        const subscriptionId = deviceSubscriptionId(user.id);
        await unsubscribeDevice(user.id, notificationRequest);
        await api.delete<'AuthSessionDeleteResponse'>('/api/v1/auth/session', { headers: { ...(subscriptionId ? { 'X-Push-Subscription-Id': subscriptionId } : {}), 'X-Notification-Account': user.id } });
        sessionRevoked.current = true;
      }
      if (clearDevice) {
        clearAccountStorage(user.id, true);
        localStorage.removeItem(deviceKey(user.id));
        if (offline && 'serviceWorker' in navigator) {
          const registration = await navigator.serviceWorker.getRegistration('/');
          const subscription = await registration?.pushManager?.getSubscription();
          if (subscription && !await subscription.unsubscribe()) throw new Error('未能取消本机通知订阅，请重试');
        }
        await notifyWorkerAccount(null);
        await clearOfflineAccount(user.id);
      } else if (offline) await notifyWorkerAccount(null);
      forgetAccount(); queryClient.clear();
      setClearCount(null);
      navigate(offline ? '/login?localLogout=1' : '/login', { replace: true });
    } catch (error) { window.dispatchEvent(new Event('settings-leave-failed')); setLogoutError(error); }
    finally { logoutLock.current = false; setBusy(false); }
  }

  return <AiReferencePreferencesProvider accountId={user.id}><div className="app-frame office-shell">
    {clearCount !== null && <Modal title="退出并清除此设备数据" onClose={() => { if (!busy) setClearCount(null); }}>
      <p>将删除当前账号在此设备的离线快照、草稿和通知记录，其他账号数据保留。</p>
      <p role="alert">尚有 {clearCount} 项未同步操作。确认后这些本机修改将被删除。</p>
      {navigator.onLine === false && <p>当前离线，服务端会话无法撤销。联网后请重新登录并退出。</p>}
      {logoutError !== null && <ErrorNotice error={logoutError} />}
      <div className="form-actions"><button className="button button-quiet" disabled={busy} onClick={() => setClearCount(null)}>取消</button><button className="button button-danger" disabled={busy} onClick={() => void logout(true)}>确认清除并退出</button></div>
    </Modal>}
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
            <button className="button button-quiet button-small" disabled={busy} onClick={() => void offerClearLogout()}>退出并清除此设备数据</button>
          </div>
        </div>
      </header>
      <main className="main-shell">{(pathname === '/app' || pathname.startsWith('/app/projects/')) && <OfflineWorkspaceStatus key={user.id} accountId={user.id}/>} {children}</main>
    </div>
  </div></AiReferencePreferencesProvider>;
}
