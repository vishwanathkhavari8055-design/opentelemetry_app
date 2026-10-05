import React, { useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { createAlertDestination, fetchAlertTemplates } from '../../services/api';
import useBackdropClose from './useBackdropClose';

/**
 * "Add Destination" — create a notification target without leaving the editor.
 *
 * Two kinds, because they are the two that matter and they need different
 * fields: email (a recipient list) and webhook (a URL and method). SNS and
 * action destinations are absent rather than half-built; both need credentials
 * this UI has no way to collect safely.
 *
 * A TEMPLATE IS MANDATORY. Without one OpenObserve silently creates a *pipeline*
 * destination, which never appears in the alert editor's list — the user would
 * see "created" and then be unable to find it. The backend rejects that case
 * too; this form simply never lets it happen.
 */

const TYPES = [
  { value: 'email', label: 'Email' },
  { value: 'http',  label: 'Webhook (HTTP)' },
];

const METHODS = ['post', 'put', 'get'];

/**
 * A light email sanity check: no whitespace, exactly one `@` with something
 * before it, and a domain with a `.` that has at least one character before it
 * and two after. Scanned by index rather than a regex, which backtracks.
 */
const isEmail = (value) => {
  if (/\s/.test(value)) return false;
  const at = value.indexOf('@');
  if (at < 1 || value.includes('@', at + 1)) return false;
  const domain = value.slice(at + 1);
  const dot = domain.indexOf('.', 1);
  return dot !== -1 && domain.length - dot - 1 >= 2;
};

export default function DestinationDialog({ onCancel, onCreated }) {
  const [name, setName] = useState('');
  const [type, setType] = useState('email');
  const [emails, setEmails] = useState('');
  const [url, setUrl] = useState('');
  const [method, setMethod] = useState('post');
  const [template, setTemplate] = useState('');
  const [skipTlsVerify, setSkipTlsVerify] = useState(false);

  const [templates, setTemplates] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const nameRef = useRef(null);
  const backdropRef = useBackdropClose(onCancel);

  useEffect(() => { nameRef.current?.focus(); }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchAlertTemplates({ signal: controller.signal })
      .then((res) => setTemplates(res.items || []))
      .catch((err) => {
        if (err.name !== 'AbortError') console.error('Templates unavailable:', err);
      });
    return () => controller.abort();
  }, []);

  // OpenObserve's templates are typed, and an email destination needs an email
  // template. Offering an http template for an email destination produces a
  // destination that fails only when the alert eventually fires — the worst
  // possible time to find out.
  const usableTemplates = useMemo(
    () => templates.filter((t) => !t.type || t.type === type),
    [templates, type],
  );

  // Keep the selection valid when the type changes underneath it.
  useEffect(() => {
    if (template && !usableTemplates.some((t) => t.name === template)) setTemplate('');
  }, [usableTemplates, template]);

  const emailList = useMemo(
    () => emails.split(/[,\s;]+/).map((s) => s.trim()).filter(Boolean),
    [emails],
  );

  const validate = () => {
    if (!name.trim()) return 'A name is required.';
    if (!/^[A-Za-z0-9_-]+$/.test(name.trim())) {
      return 'Use letters, numbers, hyphen and underscore only — no spaces.';
    }
    if (!template) return 'A template is required, otherwise alerts cannot use this destination.';
    if (type === 'email') {
      if (!emailList.length) return 'Add at least one recipient.';
      const bad = emailList.find((e) => !isEmail(e));
      if (bad) return `“${bad}” does not look like an email address.`;
    } else {
      if (!url.trim()) return 'A URL is required.';
      if (!/^https?:\/\//i.test(url.trim())) return 'The URL must start with http:// or https://.';
    }
    return '';
  };

  const submit = async (e) => {
    e.preventDefault();
    const problem = validate();
    if (problem) { setError(problem); return; }

    setBusy(true);
    setError('');
    try {
      // Built to OpenObserve's destination shape. Both kinds carry the full key
      // set — it tolerates the irrelevant ones being empty, and sending a
      // consistent body avoids type-dependent surprises.
      const body = type === 'email'
        ? {
          name: name.trim(),
          type: 'email',
          template,
          emails: emailList,
          url: '',
          method: 'post',
          skip_tls_verify: false,
        }
        : {
          name: name.trim(),
          type: 'http',
          template,
          url: url.trim(),
          method,
          skip_tls_verify: skipTlsVerify,
          emails: [],
        };
      await createAlertDestination(body);
      onCreated(name.trim());
    } catch (err) {
      setError(err.message || 'Could not create the destination.');
      setBusy(false);
    }
  };

  return (
    <dialog
      open
      ref={backdropRef}
      className="alerts-modal-backdrop native-el"
      aria-modal="true"
      aria-label="Add destination"
    >
      <form
        className="alerts-modal alerts-modal--wide"
        onSubmit={submit}
      >
        <div className="alerts-modal-head">
          <h2 className="alerts-modal-title">Add Destination</h2>
          <button type="button" className="alerts-modal-x" onClick={onCancel} aria-label="Close">×</button>
        </div>

        <div className="alerts-modal-body">
          <div className="ae-stack">
            <label className="ae-stack-label" htmlFor="dest-name">
              Name <span className="ae-req">*</span>
            </label>
            <input
              id="dest-name" ref={nameRef} className="ae-input" value={name}
              placeholder="oncall_email" maxLength={100}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="ae-stack">
            <label className="ae-stack-label" htmlFor="dest-type">Type</label>
            <select
              id="dest-type" className="ae-select" value={type}
              onChange={(e) => setType(e.target.value)}
            >
              {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>

          {type === 'email' ? (
            <div className="ae-stack">
              <label className="ae-stack-label" htmlFor="dest-emails">
                Recipients <span className="ae-req">*</span>
              </label>
              <input
                id="dest-emails" className="ae-input" value={emails}
                placeholder="oncall@example.com, sre@example.com"
                onChange={(e) => setEmails(e.target.value)}
              />
              <span className="ae-hint">
                Comma or space separated. OpenObserve only delivers to addresses that
                already belong to a user in this organization.
              </span>
            </div>
          ) : (
            <>
              <div className="ae-stack">
                <label className="ae-stack-label" htmlFor="dest-url">
                  URL <span className="ae-req">*</span>
                </label>
                <input
                  id="dest-url" className="ae-input" value={url}
                  placeholder="https://hooks.example.com/services/…"
                  onChange={(e) => setUrl(e.target.value)}
                />
              </div>
              <div className="ae-stack">
                <label className="ae-stack-label" htmlFor="dest-method">Method</label>
                <select
                  id="dest-method" className="ae-select" value={method}
                  onChange={(e) => setMethod(e.target.value)}
                >
                  {METHODS.map((m) => <option key={m} value={m}>{m.toUpperCase()}</option>)}
                </select>
              </div>
              <div className="ae-stack">
                <span className="ae-stack-label">TLS</span>
                <button
                  type="button"
                  className={`tb-switch ${skipTlsVerify ? 'is-on' : ''}`}
                  onClick={() => setSkipTlsVerify((v) => !v)}
                  aria-pressed={skipTlsVerify}
                  style={{ alignSelf: 'flex-start' }}
                >
                  <span className="tb-switch-track"><span className="tb-switch-thumb" /></span>
                  <span>Skip certificate verification</span>
                </button>
                {skipTlsVerify && (
                  <span className="ae-hint" style={{ color: 'var(--warn-color)' }}>
                    Notifications will be sent without validating the endpoint&apos;s
                    certificate. Only do this for an internal host you control.
                  </span>
                )}
              </div>
            </>
          )}

          <div className="ae-stack">
            <label className="ae-stack-label" htmlFor="dest-template">
              Template <span className="ae-req">*</span>
            </label>
            <select
              id="dest-template" className="ae-select" value={template}
              onChange={(e) => setTemplate(e.target.value)}
            >
              <option value="">Select a template…</option>
              {usableTemplates.map((t) => (
                <option key={t.name} value={t.name}>{t.name}</option>
              ))}
            </select>
            {usableTemplates.length === 0 && (
              <span className="ae-hint">
                No {type === 'email' ? 'email' : 'HTTP'} templates exist yet — create one in
                OpenObserve first. A destination without a template cannot be used by alerts.
              </span>
            )}
          </div>

          {error && <div className="ae-error">{error}</div>}
        </div>

        <div className="alerts-modal-foot">
          <button
            type="button" className="alerts-btn-ghost" onClick={onCancel} disabled={busy}
          >Cancel</button>
          <button type="submit" className="alerts-btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </dialog>
  );
}

DestinationDialog.propTypes = {
  onCancel: PropTypes.func.isRequired,
  /** Called with the created destination's name. */
  onCreated: PropTypes.func.isRequired,
};
