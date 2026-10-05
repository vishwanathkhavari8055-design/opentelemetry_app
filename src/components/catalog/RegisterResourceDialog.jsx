import React, { useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { fetchCatalogProducts, registerCatalogResource } from '../../services/api';
import useBackdropDismiss from '../common/useBackdropDismiss';

/**
 * "Register Resource" — pick a category, name the resource, register it.
 *
 * Uses the same dialog chrome as Update User (the `uem-` modal): centred box,
 * label · colon · field rows on one grid, square edges throughout.
 *
 * ─── There is no client-side pre-check, and no hints ───────────────────────
 *
 * The dialog used to carry a Validate button that queried OpenObserve before
 * anything was written, and hints under the Product and name fields explaining
 * the product/microservice relationship and the telemetry requirement. All of it
 * is gone: the panel is its fields and an action.
 *
 * Nothing is lost from the guarantee, because neither the button nor the hints
 * were what made registration safe — the SERVER validates on register and
 * refuses a resource with no telemetry, returning the message this dialog shows
 * in its error panel. A pre-check, or a note predicting it, only ever moved that
 * same answer earlier.
 *
 * What it does change is timing. Register pays the full validation cost itself
 * (several seconds against OpenObserve on a large deployment) instead of reusing
 * an answer a Validate click had already obtained, so the submit button carries
 * the only progress signal there is. Keep it disabled while in flight.
 */
export default function RegisterResourceDialog({ categories, defaultCategory, onCancel, onRegistered }) {
  const [category, setCategory] = useState(() => defaultCategory || categories[0]?.code || '');
  const [product, setProduct] = useState('');
  const [resourceName, setResourceName] = useState('');
  const [version, setVersion] = useState('');
  const [registering, setRegistering] = useState(false);
  const [error, setError] = useState('');

  // Every product, once. Loaded whole rather than per category so changing the
  // category filters locally — a fetch inside a dropdown interaction is a visible
  // stall for a list that is a few dozen rows in total.
  const [allProducts, setAllProducts] = useState([]);
  const [productsLoading, setProductsLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    fetchCatalogProducts({ signal: controller.signal })
      .then((res) => { if (!cancelled) { setAllProducts(res.items); setProductsLoading(false); } })
      .catch((err) => {
        if (cancelled || err.name === 'AbortError') return;
        // Not fatal: the categories with no product list are unaffected, and the
        // ones that need a product will say so rather than silently registering
        // against nothing.
        setProductsLoading(false);
      });
    return () => { cancelled = true; controller.abort(); };
  }, []);

  const productsForCategory = useMemo(
    () => allProducts.filter((p) => p.category === category),
    [allProducts, category],
  );

  // Whether this category HAS products is read from the data, not from a list of
  // category names here — adding the first product to a category then starts being
  // required with nothing in the UI to keep in step.
  const productRequired = productsForCategory.length > 0;

  // Reset the product whenever the category changes: a product from Applications
  // is not a valid choice under AI Services, and leaving it selected would send a
  // combination the backend has to reject.
  useEffect(() => { setProduct(''); }, [category]);

  const nameRef = useRef(null);
  useEffect(() => { nameRef.current?.focus(); }, []);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !registering) onCancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel, registering]);

  const trimmedName = resourceName.trim();
  const canSubmit = category && trimmedName.length > 0
    && (!productRequired || product) && !productsLoading;

  const submit = async (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    setRegistering(true);
    setError('');
    try {
      const created = await registerCatalogResource({
        category,
        product: productRequired ? product : '',
        resourceName: trimmedName,
        version: version.trim(),
      });
      onRegistered(created);
    } catch (err) {
      // This is where "Resource not found in OpenObserve…" surfaces, and where a
      // duplicate is reported. Re-enable the form so the name can be corrected.
      setError(err.message || 'Could not register this resource.');
      setRegistering(false);
    }
  };

  const backdropRef = useBackdropDismiss(() => { if (!registering) onCancel(); });

  return (
    <dialog
      open
      ref={backdropRef}
      className="uem-backdrop native-el"
      aria-modal="true"
      aria-label="Register resource"
    >
      {/* Same dialog chrome as Update User — `uem-` is the Settings modal, not a
          user-specific one. `uem--reg` only changes the box: this form is three or
          four rows depending on whether the category has products, so it sizes to
          its content rather than to a declared height. */}
      <form className="uem uem--reg" onSubmit={submit}>
        <div className="uem-inner">
          <header className="uem-head">
            <h2 className="uem-title">Register Resource</h2>
            <button
              type="button" className="uem-x" onClick={onCancel}
              disabled={registering} aria-label="Close"
            >×</button>
          </header>

          <div className="uem-body">
            <div className="uem-row">
              <label className="uem-label" htmlFor="pc-category">
                Category <span className="uem-req">*</span>
              </label>
              <span className="uem-colon" aria-hidden="true">:</span>
              <div className="uem-field">
                <select
                  id="pc-category"
                  className="uem-select"
                  value={category}
                  disabled={registering}
                  onChange={(e) => { setCategory(e.target.value); setError(''); }}
                >
                  {categories.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.label}{c.registeredCount ? ` (${c.registeredCount} registered)` : ''}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* PRODUCT — the middle tier. Rendered only for the categories that have
                one: Tools, Databases, Platform and DLH are registered by bare name,
                and an empty dropdown there would look like a failed load. */}
            {productRequired && (
              <div className="uem-row">
                <label className="uem-label" htmlFor="pc-product">
                  Product <span className="uem-req">*</span>
                </label>
                <span className="uem-colon" aria-hidden="true">:</span>
                <div className="uem-field">
                  <select
                    id="pc-product"
                    className="uem-select"
                    value={product}
                    disabled={registering}
                    onChange={(e) => { setProduct(e.target.value); setError(''); }}
                  >
                    <option value="">Select a product…</option>
                    {productsForCategory.map((p) => (
                      <option key={p.code} value={p.code}>
                        {p.label}
                        {p.note ? ` — ${p.note}` : ''}
                        {p.registeredCount ? ` (${p.registeredCount})` : ''}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {productsLoading && (
              <p className="uem-note">Loading products…</p>
            )}

            <div className="uem-row">
              <label className="uem-label" htmlFor="pc-name">
                {productRequired ? 'Microservice' : 'Resource Name'} <span className="uem-req">*</span>
              </label>
              <span className="uem-colon" aria-hidden="true">:</span>
              <div className="uem-field">
                <input
                  id="pc-name"
                  ref={nameRef}
                  className="uem-input"
                  value={resourceName}
                  disabled={registering}
                  maxLength={255}
                  autoComplete="off"
                  placeholder={productRequired ? 'tiotesb' : 'PostgreSQL'}
                  onChange={(e) => { setResourceName(e.target.value); setError(''); }}
                />
              </div>
            </div>

            {/* VERSION — free text, and optional. Real estates carry "1.4.2",
                "2024.3", "v3-rc1" and "latest" side by side, so a pattern strict
                enough to be meaningful would reject most of them. Nothing sorts or
                compares it; it is recorded so the table can show what is deployed. */}
            <div className="uem-row">
              <label className="uem-label" htmlFor="pc-version">Version</label>
              <span className="uem-colon" aria-hidden="true">:</span>
              <div className="uem-field">
                <input
                  id="pc-version"
                  className="uem-input"
                  value={version}
                  disabled={registering}
                  maxLength={64}
                  autoComplete="off"
                  placeholder="2.4.1"
                  onChange={(e) => { setVersion(e.target.value); setError(''); }}
                />
              </div>
            </div>

            {/* Where "Resource not found in OpenObserve…" and the duplicate report
                surface. The server validates on register, so this is the only place
                that answer is given — it is not a restatement of a hint. */}
            {error && (
              <div className="uem-info uem-info--error" role="alert">
                <span className="uem-info-icon" aria-hidden="true">!</span>
                <p className="uem-info-text">{error}</p>
              </div>
            )}
          </div>

          <footer className="uem-foot">
            <button
              type="button" className="uem-btn uem-btn--ghost" onClick={onCancel}
              disabled={registering}
            >Cancel</button>
            <button
              type="submit"
              className="uem-btn uem-btn--primary"
              disabled={registering || !canSubmit}
            >{registering ? 'Registering…' : 'Register'}</button>
          </footer>
        </div>
      </form>
    </dialog>
  );
}

/**
 * The Logs / Traces / Metrics tick list.
 *
 * <p>Lives here for historical reasons — the register dialog used to show it in
 * its validation report. Its only caller now is the details drawer, which is why
 * it stays exported.</p>
 */
export function SignalChecklist({ signals }) {
  const rows = [
    ['Logs', signals?.logs],
    ['Traces', signals?.traces],
    ['Metrics', signals?.metrics],
  ];
  return (
    <ul className="pc-signals">
      {rows.map(([label, on]) => (
        <li key={label} className={on ? 'is-on' : 'is-off'}>
          <span className="pc-signal-mark" aria-hidden="true">{on ? '✔' : '✖'}</span>
          <span className="pc-signal-label">{label}</span>
          <span className="pc-sr-only">{on ? 'available' : 'not available'}</span>
        </li>
      ))}
    </ul>
  );
}

SignalChecklist.propTypes = {
  signals: PropTypes.shape({
    logs: PropTypes.bool,
    traces: PropTypes.bool,
    metrics: PropTypes.bool,
  }),
};

RegisterResourceDialog.propTypes = {
  /** From GET /api/product-catalog/categories — the backend owns this list. */
  categories: PropTypes.arrayOf(PropTypes.shape({
    code: PropTypes.string.isRequired,
    label: PropTypes.string.isRequired,
    description: PropTypes.string,
    registeredCount: PropTypes.number,
  })).isRequired,
  /** Preselect the category the table is currently filtered to, if any. */
  defaultCategory: PropTypes.string,
  onCancel: PropTypes.func.isRequired,
  /** Called with the created resource after a successful registration. */
  onRegistered: PropTypes.func.isRequired,
};
