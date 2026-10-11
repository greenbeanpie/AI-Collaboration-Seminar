import { Navigate, useLocation } from 'react-router-dom';

export function WorkspaceLegacyRedirect({ from, to }: { from: string; to: string }) {
  const { pathname, search, hash } = useLocation();
  const destination = pathname === '/app/settings/privacy' ? '/app/profile' : to + pathname.slice(from.length);
  return <Navigate to={destination + search + hash} replace />;
}
