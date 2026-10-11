import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import './SupportHelpLayout.css';

export function SupportHelpLayout() {
  const ticketsActive = useLocation().pathname !== '/app/support/help';
  return <div className="support-help-layout">
    <nav className="support-help-tabs" aria-label="支持与帮助">
      <Link to="/app/support" className={ticketsActive ? 'active' : undefined} aria-current={ticketsActive ? 'page' : undefined}>支持工单</Link>
      <NavLink to="/app/support/help">帮助文档</NavLink>
    </nav>
    <Outlet />
  </div>;
}
