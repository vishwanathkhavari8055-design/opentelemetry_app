/**
 * AuthGate — the top-level route guard (without a router).
 *
 * One choke point: either the SSO landing page (validating, failed, or signed
 * out) or the protected application. There is no login form behind it — the
 * session comes from the portal hand-off that SsoLanding drives, and until that
 * resolves nothing inside the app mounts or fetches.
 */
import PropTypes from 'prop-types';
import { useAuth } from './AuthContext';
import SsoLanding from '../components/auth/SsoLanding';

function AuthGate({ children }) {
  const { isAuthenticated } = useAuth();

  // Covers INITIALIZING as well: the landing renders its own "signing you in"
  // state, so the splash and the failure screen are one component rather than
  // two that have to agree with each other.
  if (!isAuthenticated) return <SsoLanding />;
  return children;
}

AuthGate.propTypes = {
  children: PropTypes.node,
};

export default AuthGate;
