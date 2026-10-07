import { useState, useSyncExternalStore } from 'react';
import { getInstallState, subscribe, promptInstall } from '../pwa-install';
import { DesktopSettings } from '../desktop/DesktopRuntime';
import { isDesktop } from '../desktop/bridge';
export function InstallationSettings() {
  const state = useSyncExternalStore(subscribe, getInstallState);
  const [message, setMessage] = useState('');
  if (isDesktop()) return <DesktopSettings />;
  return <section className="delivery-card"><h2>安装应用</h2><p>安装后可从桌面或主屏幕打开独立窗口。安装与通知授权是两项独立设置。</p>
    <p role="status">{state.installed ? '当前已在独立应用窗口运行，无需再次安装。' : state.canInstall ? '浏览器已准备好安装此应用。' : '当前浏览器没有提供一键安装入口。'}</p>
    <button type="button" disabled={!state.canInstall || state.installed} onClick={() => { void promptInstall().then(outcome => setMessage(outcome === 'accepted' ? '安装已接受，可从桌面或主屏幕打开。' : outcome === 'dismissed' ? '已取消安装，你可以稍后再试。' : '浏览器未提供安装提示，请使用菜单中的安装入口。')); }}>安装到设备</button>
    {message && <p role="status">{message}</p>}
    <p className="delivery-help">iPhone/iPad：在 Safari 的分享菜单选择“添加到主屏幕”。其他浏览器可查看菜单中的“安装应用”或“添加到主屏幕”。菜单和可用条件由浏览器决定。</p>
    <p className="delivery-help">首次收到安装机会时会保留原有提醒；取消安装不会跳转页面或丢失正在编辑的内容。</p>
  </section>;
}
