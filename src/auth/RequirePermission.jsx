/**
 * Role guard for the view layer.
 *
 * Renders `children` only when the current user holds the required permission(s).
 * Otherwise renders `fallback` (default: nothing). Use it to hide admin-only
 * actions from the read-only operator so unauthorized controls never appear.
 *
 *   <RequirePermission permission={PERMISSIONS.CONFIGURE_ALERTS}>
 *     <button>Edit</button>
 *   </RequirePermission>
 *
 * For "show but disabled" affordances, prefer the `usePermissions().can(...)`
 * hook directly and pass `disabled` to the control.
 */
import PropTypes from 'prop-types';
import { usePermissions } from './usePermissions';

function RequirePermission({ permission, anyOf, allOf, fallback = null, children }) {
  const { can, canAny, canAll } = usePermissions();

  let allowed = true;
  if (permission) allowed = allowed && can(permission);
  if (anyOf?.length) allowed = allowed && canAny(anyOf);
  if (allOf?.length) allowed = allowed && canAll(allOf);

  return allowed ? children : fallback;
}

RequirePermission.propTypes = {
  permission: PropTypes.string,
  anyOf: PropTypes.arrayOf(PropTypes.string),
  allOf: PropTypes.arrayOf(PropTypes.string),
  fallback: PropTypes.node,
  children: PropTypes.node,
};

export default RequirePermission;
