/**
 * Permission-focused hooks built on top of useAuth. Components import these to
 * hide/disable actions rather than checking roles inline, keeping RBAC logic in
 * one place.
 */
import { useCallback, useMemo } from 'react';
import { useAuth } from './AuthContext';
import { hasPermission, hasAllPermissions, hasAnyPermission, isAdmin, isOperator } from './permissions';

/**
 * @returns {{
 *   role: string | null,
 *   can: (permission: string) => boolean,
 *   canAll: (permissions: string[]) => boolean,
 *   canAny: (permissions: string[]) => boolean,
 *   isAdmin: boolean,
 *   isOperator: boolean,
 *   isReadOnly: boolean,
 * }}
 */
export function usePermissions() {
  const { role } = useAuth();

  const can = useCallback((permission) => hasPermission(role, permission), [role]);
  const canAll = useCallback((permissions) => hasAllPermissions(role, permissions), [role]);
  const canAny = useCallback((permissions) => hasAnyPermission(role, permissions), [role]);

  return useMemo(
    () => ({
      role,
      can,
      canAll,
      canAny,
      isAdmin: isAdmin(role),
      isOperator: isOperator(role),
      // The operator is read-only; anyone who isn't an admin is treated as such.
      isReadOnly: !isAdmin(role),
    }),
    [role, can, canAll, canAny],
  );
}

/** Thin convenience hook for a single permission check. */
export function useCan(permission) {
  const { can } = usePermissions();
  return can(permission);
}
