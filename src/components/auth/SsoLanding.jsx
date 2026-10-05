/**
 * SSO landing — the hand-off from the portal.
 *
 * <h3>The successful path shows NOTHING</h3>
 *
 * <p>Clicking a portal link should land on Home. A card announcing that you are
 * being signed in is a login page by another name — it is the screen the user
 * asked to be rid of, and on a hand-off that resolves in milliseconds it is a
 * flash of chrome between two useful screens.</p>
 *
 * <p>So while validation is in flight this renders NOTHING for
 * {@link PROGRESS_DELAY_MS}. Nearly always the role comes back first and the app
 * mounts with no intermediate screen at all. Only if the exchange is genuinely
 * slow does a minimal splash appear — a blank window for several seconds is the
 * one outcome worse than a brief splash, and that is the case it exists for.</p>
 *
 * <h3>Failures still get a full screen</h3>
 *
 * <p>Nothing is typed here in any state. When validation fails the card returns,
 * because "link incomplete", "role not recognised" and "the service refused" are
 * different problems with different fixes, and a user staring at a blank page
 * cannot act on any of them.</p>
 *
 * The work itself belongs to AuthContext; this component only renders it.
 */
import React, { useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import { useAuth } from '../../auth/AuthContext';
import { AUTH_ERRORS } from '../../auth/authService';
// White-on-transparent mark. The surface behind it is dark (--bg-color), so it
// reads correctly; it would be invisible on a light background.
import logoUrl from '../../assets/logo.png';

/**
 * How long the hand-off may take before the user is told anything.
 *
 * <p>Tuned to be longer than a normal exchange and shorter than the point at
 * which a blank window reads as broken. Below it, the portal link goes straight
 * to Home with no intermediate screen; above it, a splash beats a void.</p>
 */
const PROGRESS_DELAY_MS = 400;

/** Human label for each parameter the link is expected to carry. */
const PARAM_LABELS = {
  role: 'role',
  tenantCode: 'tenantCode',
  refKey: 'refKey',
};

/**
 * A one-line hint on what to DO about a failure. Generic copy ("something went
 * wrong") leaves the user with no next step, and the next step genuinely
 * differs per cause.
 */
function hintFor(code) {
  switch (code) {
    case AUTH_ERRORS.MISSING_SSO_PARAMS:
      return 'Open it from your portal so your tenant and role travel with the link.';
    case AUTH_ERRORS.UNKNOWN_ROLE:
      return 'Ask your administrator to map this role to Administrator or Operator access.';
    case AUTH_ERRORS.SSO_REJECTED:
      return 'Your portal session may have ended. Sign in to the portal again and reopen this application.';
    case AUTH_ERRORS.SESSION_EXPIRED:
      return 'Reopen the application from the portal to start a new session.';
    case AUTH_ERRORS.NETWORK:
    case AUTH_ERRORS.SERVICE_UNAVAILABLE:
      return 'This is usually temporary — try again in a moment.';
    default:
      return 'Try again, or reopen the application from your portal.';
  }
}

/** The identity context read off the URL, rendered as labelled chips. */
function SsoContext({ sso }) {
  const rows = [
    ['Tenant', sso.tenantCode],
    ['Role', sso.role],
    ['Reference', sso.refKey],
    ['Language', sso.lang],
  ].filter(([, value]) => Boolean(value));

  if (!rows.length) return null;

  return (
    <dl className="sso-context">
      {rows.map(([label, value]) => (
        <div className="sso-context-row" key={label}>
          <dt className="sso-context-key">{label}</dt>
          <dd className="sso-context-val">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

SsoContext.propTypes = {
  sso: PropTypes.shape({
    role: PropTypes.string,
    tenantCode: PropTypes.string,
    refKey: PropTypes.string,
    lang: PropTypes.string,
  }).isRequired,
};

export default function SsoLanding() {
  const { isInitializing, isSubmitting, error, signedOut, sso, retry } = useAuth();

  const validating = isInitializing || isSubmitting;

  /**
   * Has the exchange been running long enough to be worth mentioning?
   *
   * <p>False for the first {@link PROGRESS_DELAY_MS}, which on a normal hand-off
   * is the entire duration — so the user goes from the portal to Home without
   * passing through a screen. The timer is cleared the moment validation ends,
   * so a fast success never flips it.</p>
   */
  const [showProgress, setShowProgress] = useState(false);
  useEffect(() => {
    if (!validating) {
      setShowProgress(false);
      return undefined;
    }
    const timer = setTimeout(() => setShowProgress(true), PROGRESS_DELAY_MS);
    return () => clearTimeout(timer);
  }, [validating]);

  // ── In flight ───────────────────────────────────────────────────────────
  // Nothing, then a bare splash if it drags. Deliberately NOT the card: the
  // card is what reads as a login page, and there is nothing here to log in to.
  if (validating) {
    if (!showProgress) return null;
    return (
      <output className="auth-splash native-el" aria-live="polite">
        <img
          className="auth-splash-logo"
          src={logoUrl}
          alt="MONITOR — Logging and Monitoring Tool"
        />
        <div className="auth-spinner auth-spinner--lg" aria-hidden="true" />
        <span className="auth-splash-text">Opening your workspace…</span>
      </output>
    );
  }

  // ── Signed out, or something went wrong ─────────────────────────────────
  return (
    <div className="auth-shell">
      {/* Ambient background accents (pure decoration, non-interactive). */}
      <div className="auth-bg" aria-hidden="true">
        <span className="auth-bg-glow auth-bg-glow--1" />
        <span className="auth-bg-glow auth-bg-glow--2" />
        <span className="auth-bg-grid" />
      </div>

      <main className="auth-card sso-card" role="main">
        <header className="auth-card-head">
          <img
            className="auth-logo-img"
            src={logoUrl}
            alt="MONITOR — Logging and Monitoring Tool"
          />
        </header>

        {signedOut && (
          <output className="sso-state native-el" aria-live="polite">
            <h1 className="sso-title">You have signed out</h1>
            <p className="sso-text">
              Your session on this device has ended. Nothing is kept here after sign-out.
            </p>
            <button type="button" className="auth-submit" onClick={retry}>
              Sign in again
            </button>
          </output>
        )}

        {!signedOut && error && (
          <div className="sso-state">
            <div className="auth-alert" role="alert" aria-live="assertive">
              <span className="auth-alert-icon" aria-hidden="true">!</span>
              <span className="auth-alert-text">{error.message}</span>
            </div>

            {/* Which parameters the link was missing — the difference between
                "it's broken" and "the link needs role and tenantCode". */}
            {error.details?.missing?.length > 0 && (
              <p className="sso-text">
                Missing from the link:{' '}
                {error.details.missing.map((key, i) => (
                  <React.Fragment key={key}>
                    {i > 0 && ', '}
                    <code className="sso-code">{PARAM_LABELS[key] || key}</code>
                  </React.Fragment>
                ))}
              </p>
            )}

            <SsoContext sso={sso} />

            <p className="sso-hint">{hintFor(error.code)}</p>

            <button type="button" className="auth-submit" onClick={retry}>
              Try again
            </button>
          </div>
        )}

        {/* Not in flight, no error, not signed out — a frame between states.
            Keeps the card from rendering as an empty box if it is ever seen. */}
        {!signedOut && !error && (
          <output className="sso-state native-el" aria-live="polite">
            <div className="auth-spinner auth-spinner--lg" aria-hidden="true" />
            <p className="sso-text">Opening your workspace…</p>
          </output>
        )}
      </main>
    </div>
  );
}
