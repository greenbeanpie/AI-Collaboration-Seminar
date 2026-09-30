export type AccountRole = 'super_admin' | 'admin' | 'user';
/** Explicit role always wins; legacy admin flags never confer super-admin privileges. */
export function accountRole(row: { account_role: AccountRole | null; is_admin: number }): AccountRole {
  return row.account_role ?? (row.is_admin === 1 ? 'admin' : 'user');
}
export const accountRoleSql = "COALESCE(account_role, CASE WHEN is_admin = 1 THEN 'admin' ELSE 'user' END)";
