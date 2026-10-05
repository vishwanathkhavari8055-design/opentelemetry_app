/**
 * Pure permission helpers. No React, no side effects — just the RBAC rules so
 * they can be unit-tested and reused by guards, hooks and services alike.
 */
import { PERMISSION_MATRIX, ALL_PERMISSIONS, ROLES } from './constants';

/**
 * Does `role` grant `permission`?
 * The administrator holds the wildcard, so every check passes.
 */
export function hasPermission(role, permission) {
  if (!role || !permission) return false;
  const granted = PERMISSION_MATRIX[role];
  if (!granted) return false;
  if (granted.includes(ALL_PERMISSIONS)) return true;
  return granted.includes(permission);
}

/** True if the role satisfies every permission in the list. */
export function hasAllPermissions(role, permissions = []) {
  return permissions.every((p) => hasPermission(role, p));
}

/** True if the role satisfies at least one permission in the list. */
export function hasAnyPermission(role, permissions = []) {
  return permissions.some((p) => hasPermission(role, p));
}

/** Convenience: is this role the administrator? */
export function isAdmin(role) {
  return role === ROLES.ADMIN;
}

/** Convenience: is this role the (read-only) operator? */
export function isOperator(role) {
  return role === ROLES.OPERATOR;
}
