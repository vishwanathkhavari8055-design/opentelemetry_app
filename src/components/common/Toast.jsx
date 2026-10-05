import React, { useEffect, useRef } from 'react';
import PropTypes from 'prop-types';

/**
 * Floating toast, bottom-right. Three tones: success, warning, error.
 *
 * Replaces the full-width inline banner these screens used to push into their
 * layout. A message about something that has already happened does not need to
 * reflow the page it is reporting on — the banner shifted the table down and
 * then back up again when it went, which moved rows under the pointer.
 *
 * ─── Errors do not auto-dismiss ────────────────────────────────────────────
 *
 * This started out success-only, on the grounds that a failure carries a reason
 * the user has to be able to finish reading. That reasoning was about the TIMER,
 * not about the corner — so errors are toasts too now, and it is the timer they
 * opt out of: `success` and `warn` clear themselves after `duration`, `error`
 * stays until it is dismissed and is the only tone given an ✕ to do it with.
 *
 * Anything genuinely persistent — "alert ingest is not healthy", "this table
 * could not load" — is still an inline banner rather than a toast. Those
 * describe the state of the screen rather than the outcome of a click, they are
 * true until the backend changes, and a toast raised on every poll would be a
 * message that never stops arriving.
 *
 * ─── Live region ───────────────────────────────────────────────────────────
 *
 * `role="status"` / `aria-live="polite"` for success and warn: they announce
 * after whatever the user is doing rather than interrupting it, which is also
 * what makes it safe for them to auto-dismiss — a message a screen reader has
 * already queued is not lost when the node goes. `role="alert"` (assertive) for
 * errors, which should interrupt, and which nothing removes from under the
 * reader mid-sentence.
 */

/** Long enough to read a sentence, short enough not to sit over the UI. */
const DEFAULT_DURATION = 3000;

const TONES = ['success', 'warn', 'error'];

/** Default heading per tone. Callers can override with `title`. */
const TONE_TITLE = {
  success: 'Success',
  warn: 'Warning',
  error: 'Error',
};

/* Tick for success; the same exclamation for warn and error, which differ by
   fill rather than by glyph — two shapes for "this did not work" and "this only
   partly worked" would be a distinction nobody reads at a glance anyway. */
const ToneIcon = ({ tone }) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
  >
    {tone === 'success'
      ? <path d="M4 12.5 9.5 18 20 6.5" />
      : <><path d="M12 4v10" /><path d="M12 19.5v.01" /></>}
  </svg>
);
ToneIcon.propTypes = { tone: PropTypes.oneOf(TONES).isRequired };

export default function Toast({ message, tone, title, duration, onDismiss }) {
  const isError = tone === 'error';

  /*
     `onDismiss` behind a ref, and DELIBERATELY NOT a dependency of the timer
     below.

     Every caller passes an inline arrow — `onDismiss={() => setToast(null)}` —
     so the prop is a new function on every render of the parent. With it in the
     dependency array the effect tore down and re-armed the timer on each of
     those renders, which means the countdown restarted from zero every time
     anything else on the screen changed. On Settings that was invisible: nothing
     re-renders it while a toast is up. On the fired-alerts tab, which polls on a
     refresh interval, the timer would be reset before it ever fired and the
     toast would sit there until the tab changed.

     The ref keeps the newest callback reachable without making its identity a
     reason to restart the clock.
  */
  const onDismissRef = useRef(onDismiss);
  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  // Keyed on `message`, so a new message restarts the clock rather than
  // inheriting the tail of the previous one's. Cleared on unmount, which is what
  // stops the timer firing into an unmounted parent.
  //
  // `isError` is a dependency because it decides whether there is a timer at
  // all: an error arriving while a success is still on screen must cancel that
  // success's pending dismissal rather than inherit it.
  useEffect(() => {
    if (!message || isError) return undefined;
    const timer = setTimeout(() => onDismissRef.current(), duration);
    return () => clearTimeout(timer);
  }, [message, isError, duration]);

  if (!message) return null;

  return (
    <div
      className={`toast toast--${tone}`}
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
    >
      <span className="toast-icon">
        <ToneIcon tone={tone} />
      </span>
      <div className="toast-body">
        <strong className="toast-title">{title || TONE_TITLE[tone]}</strong>
        <span className="toast-message">{message}</span>
      </div>
      {/* Only on the tone that has no timer — the other two are gone before a
          close button would be worth aiming at. */}
      {isError && (
        <button type="button" className="toast-x" onClick={onDismiss} aria-label="Dismiss">
          ×
        </button>
      )}
    </div>
  );
}

Toast.propTypes = {
  /** The message. Falsy renders nothing, so callers can pass state directly. */
  message: PropTypes.string,
  /** Fill and behaviour. `error` does not auto-dismiss and gets a close button. */
  tone: PropTypes.oneOf(TONES),
  /** Heading. Defaults per tone — "Success" / "Warning" / "Error". */
  title: PropTypes.string,
  /** Milliseconds on screen before `onDismiss` fires. Ignored when tone is `error`. */
  duration: PropTypes.number,
  /** Clear the caller's message state. Called on the timer, and by the ✕. */
  onDismiss: PropTypes.func.isRequired,
};

Toast.defaultProps = {
  message: '',
  tone: 'success',
  title: '',
  duration: DEFAULT_DURATION,
};
