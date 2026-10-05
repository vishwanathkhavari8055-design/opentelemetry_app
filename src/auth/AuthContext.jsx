/**
 * AuthContext — the single source of truth for "who is signed in".
 *
 * The session is established by the PORTAL, not by this app: there is no login
 * form. On start-up the landing page reads the SSO context off the URL
 * (?role=…&tenantCode=…&refKey=…&lang=…), exchanges it for a session through
 * authService.loginBySso, and the resolved role decides which UI the user gets
 * — Administrator (full access) or Operator (read-only). That decision is made
 * once, here, and every screen below reads it through the permission hooks.
 *
 * Responsibilities:
 *   • Run the SSO exchange on cold start, with a retryable failure state.
 *   • Fall back to a stored session when the app is reloaded without the URL
 *     context (a bookmark, a manual refresh after the portal stripped them).
 *   • Scheduled silent renewal before the access token expires.
 *   • Hard auto-logout when the session finally expires.
 *
 * Consumers use the `useAuth` hook (below) or the permission hooks in
 * ./usePermissions. Nothing here logs tokens or SSO secrets.
 */
import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from 'react';
import PropTypes from 'prop-types';

import { loginBySso, refresh as refreshSession, userFromAccessToken, AUTH_ERRORS } from './authService';
import { readSsoParams } from './ssoParams';
import {
  persistSession,
  persistTokens,
  clearSession,
  getAccessToken,
  getRefreshToken,
  getStoredUser,
} from './tokenStorage';
import { isTokenExpired, secondsUntilExpiry } from './jwtService';
import { hasPermission } from './permissions';

/** Authentication lifecycle states. */
export const AUTH_STATUS = Object.freeze({
  INITIALIZING: 'INITIALIZING', // running the SSO exchange / restoring a session
  AUTHENTICATED: 'AUTHENTICATED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
});

const AuthContext = createContext(null);

/** Epoch seconds — one place so it's easy to reason about token math. */
function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

/** Renew this many seconds *before* the access token actually expires. */
const REFRESH_SKEW_SECONDS = 60;

export function AuthProvider({ children }) {
  const [status, setStatus] = useState(AUTH_STATUS.INITIALIZING);
  const [user, setUser] = useState(null);
  const [error, setError] = useState(null); // { code, message, details } | null
  const [isSubmitting, setIsSubmitting] = useState(false);
  /** True after an explicit "Sign out" — the landing says goodbye rather than
   *  reporting a failure, and does NOT silently sign the user straight back in
   *  from the URL still sitting in the address bar. */
  const [signedOut, setSignedOut] = useState(false);

  /** The SSO context this session was (or would be) established from. Exposed
   *  so the landing screen can show the tenant/role it is acting on. */
  const [ssoParams, setSsoParams] = useState(() => readSsoParams());

  const refreshTimerRef = useRef(null);
  const inFlightRef = useRef(false); // duplicate-submit / concurrent-renewal guard
  const startedRef = useRef(false); // StrictMode double-effect guard
  const abortRef = useRef(null);
  // Holds the latest doSilentRefresh so the renewal timer can call it without
  // scheduleRefresh and doSilentRefresh forming a circular useCallback dep.
  const doSilentRefreshRef = useRef(null);

  const clearRefreshTimer = useCallback(() => {
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
  }, []);

  /** Tear down the session locally (no network). Optionally surface a reason. */
  const finalizeLogout = useCallback(
    (reason = null) => {
      clearRefreshTimer();
      clearSession();
      setUser(null);
      setStatus(AUTH_STATUS.UNAUTHENTICATED);
      setError(reason);
    },
    [clearRefreshTimer],
  );

  /**
   * Arm a timer to renew shortly before `accessToken` expires. If it has
   * already (nearly) expired, renew right away. Calls through a ref so it
   * carries no dependency on doSilentRefresh (which in turn calls it back).
   */
  const scheduleRefresh = useCallback(
    (accessToken) => {
      clearRefreshTimer();
      const remaining = secondsUntilExpiry(accessToken, nowSeconds());
      const fireIn = Math.max(0, remaining - REFRESH_SKEW_SECONDS);
      refreshTimerRef.current = setTimeout(() => {
        doSilentRefreshRef.current?.();
      }, fireIn * 1000);
    },
    [clearRefreshTimer],
  );

  /**
   * Attempt a silent renewal. On success, re-arm the timer. On failure
   * (expired/invalid refresh token), hard-logout with a session-expired notice.
   */
  const doSilentRefresh = useCallback(async () => {
    if (inFlightRef.current) return; // never fire two renewals at once
    const refreshToken = getRefreshToken();
    if (!refreshToken || isTokenExpired(refreshToken, nowSeconds())) {
      finalizeLogout({
        code: AUTH_ERRORS.SESSION_EXPIRED,
        message: 'Your session has expired. Please reopen the application from the portal.',
      });
      return;
    }
    inFlightRef.current = true;
    try {
      const result = await refreshSession({ refreshToken, nowSeconds: nowSeconds() });
      persistTokens({ accessToken: result.accessToken, refreshToken: result.refreshToken });
      setUser(result.user);
      scheduleRefresh(result.accessToken);
    } catch (err) {
      finalizeLogout({
        code: err?.code || AUTH_ERRORS.SESSION_EXPIRED,
        message: err?.message || 'Your session has expired. Please reopen the application from the portal.',
      });
    } finally {
      inFlightRef.current = false;
    }
  }, [finalizeLogout, scheduleRefresh]);

  // Keep the ref pointing at the latest doSilentRefresh for the timer callback.
  useEffect(() => {
    doSilentRefreshRef.current = doSilentRefresh;
  }, [doSilentRefresh]);

  /** Adopt a validated session: persist it, expose it, arm the renewal. */
  const adoptSession = useCallback(
    ({ user: nextUser, accessToken, refreshToken }) => {
      // Always sessionStorage (remember = false): an SSO hand-off is scoped to
      // the tab the portal opened, and a session that outlived the browser would
      // outlive the portal's own.
      persistSession({ accessToken, refreshToken, user: nextUser, remember: false });
      setUser(nextUser);
      setError(null);
      setSignedOut(false);
      setStatus(AUTH_STATUS.AUTHENTICATED);
      scheduleRefresh(accessToken);
    },
    [scheduleRefresh],
  );

  /**
   * Restore a session already in storage.
   * @returns {Promise<boolean>} whether a session was recovered
   */
  const restoreStoredSession = useCallback(async () => {
    const accessToken = getAccessToken();
    const refreshToken = getRefreshToken();
    if (!accessToken && !refreshToken) return false;

    const restoredUser = userFromAccessToken(accessToken, nowSeconds()) || getStoredUser();
    if (accessToken && !isTokenExpired(accessToken, nowSeconds()) && restoredUser) {
      setUser(restoredUser);
      setError(null);
      setStatus(AUTH_STATUS.AUTHENTICATED);
      scheduleRefresh(accessToken);
      return true;
    }

    if (refreshToken && !isTokenExpired(refreshToken, nowSeconds())) {
      try {
        const result = await refreshSession({ refreshToken, nowSeconds: nowSeconds() });
        persistTokens({ accessToken: result.accessToken, refreshToken: result.refreshToken });
        setUser(result.user);
        setError(null);
        setStatus(AUTH_STATUS.AUTHENTICATED);
        scheduleRefresh(result.accessToken);
        return true;
      } catch {
        /* fall through — treat as no session */
      }
    }

    clearSession();
    return false;
  }, [scheduleRefresh]);

  /**
   * The whole entry flow, in one place.
   *
   * <p>Order matters. The URL is the AUTHORITY when it carries an SSO context:
   * the portal may have handed this tab a different tenant or a lower role than
   * the session already in storage, and honouring the stale session instead
   * would show the wrong tenant's telemetry under the right person's name. A
   * stored session is used only when the URL says nothing.</p>
   */
  const runEntryFlow = useCallback(async () => {
    if (inFlightRef.current) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const params = readSsoParams();
    setSsoParams(params);
    inFlightRef.current = true;
    setIsSubmitting(true);
    setStatus(AUTH_STATUS.INITIALIZING);
    setError(null);
    setSignedOut(false);

    try {
      if (params.valid) {
        const result = await loginBySso({
          params,
          nowSeconds: nowSeconds(),
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        adoptSession(result);
        return;
      }

      // No usable SSO context on the URL — a reload or a bookmark. A live
      // session is the graceful answer; otherwise say what the link was missing.
      const restored = await restoreStoredSession();
      if (controller.signal.aborted || restored) return;

      finalizeLogout({
        code: AUTH_ERRORS.MISSING_SSO_PARAMS,
        message: params.present
          ? 'This link is missing part of your sign-in details.'
          : 'This application must be opened from the portal.',
        details: { missing: params.missing },
      });
    } catch (err) {
      if (controller.signal.aborted) return;
      finalizeLogout({
        code: err?.code || AUTH_ERRORS.UNKNOWN,
        message: err?.message || 'Sign-in failed. Please try again.',
        details: err?.details || null,
      });
    } finally {
      inFlightRef.current = false;
      setIsSubmitting(false);
    }
  }, [adoptSession, finalizeLogout, restoreStoredSession]);

  /** Cold start. The ref guard keeps StrictMode's double-effect from firing the
   *  SSO exchange twice in development. */
  useEffect(() => {
    if (startedRef.current) return undefined;
    startedRef.current = true;
    runEntryFlow();
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Clean up the renewal timer on unmount.
   *
   * <p>Deliberately does NOT abort an in-flight SSO exchange. StrictMode
   * simulates an unmount immediately after the first mount, so aborting here
   * killed the very request the effect above had just started — and because the
   * start is guarded against re-running, nothing ever started it again: the
   * landing page sat on "Signing you in…" forever. Development-only symptom,
   * but it made the app unusable in development.</p>
   *
   * <p>The abort that matters is still there: {@link runEntryFlow} aborts the
   * previous attempt before starting a new one, and logout aborts explicitly.
   * A request outliving the provider settles into state nobody reads, which
   * React 18 handles without complaint.</p>
   */
  useEffect(() => clearRefreshTimer, [clearRefreshTimer]);

  // Legacy-cookie cleanup, not a feature. This used to mirror the role into an
  // `lnm_role` cookie that a dev proxy read to choose an upstream token — a
  // browser-written cookie deciding a privilege level, which any user could
  // rewrite with one devtools line. Both the proxy and the screen behind it are
  // gone, so nothing reads the cookie at all now.
  //
  // It is actively cleared rather than merely left unwritten, so a stale
  // `lnm_role` from an older build can't linger in a browser and read as if
  // role-based access via a cookie were still a thing.
  useEffect(() => {
    document.cookie = 'lnm_role=; path=/; Max-Age=0; SameSite=Lax';
  }, [user]);

  /** Re-run the SSO exchange — the landing screen's "Try again". */
  const retry = useCallback(() => {
    runEntryFlow();
  }, [runEntryFlow]);

  /** Explicit, user-initiated sign-out. */
  const logout = useCallback(() => {
    abortRef.current?.abort();
    finalizeLogout(null);
    setSignedOut(true);
  }, [finalizeLogout]);

  const clearError = useCallback(() => setError(null), []);

  /** Permission check bound to the current user's role. */
  const can = useCallback((permission) => hasPermission(user?.role, permission), [user]);

  const value = useMemo(
    () => ({
      status,
      isInitializing: status === AUTH_STATUS.INITIALIZING,
      isAuthenticated: status === AUTH_STATUS.AUTHENTICATED,
      user,
      role: user?.role || null,
      tenantCode: user?.tenantCode || ssoParams.tenantCode || '',
      error,
      isSubmitting,
      signedOut,
      sso: ssoParams,
      retry,
      logout,
      clearError,
      can,
    }),
    [status, user, ssoParams, error, isSubmitting, signedOut, retry, logout, clearError, can],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

AuthProvider.propTypes = {
  children: PropTypes.node,
};

/** Primary hook. Throws if used outside the provider (developer error). */
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an <AuthProvider>.');
  }
  return ctx;
}

export default AuthContext;
