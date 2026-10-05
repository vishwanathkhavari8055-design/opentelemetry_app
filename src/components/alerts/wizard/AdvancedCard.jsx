import React, { useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import TokenInput from '../TokenInput';
import { fetchAlertTemplates } from '../../../services/api';
import { PRIORITIES, ROW_TEMPLATE_TYPES, nextKey } from '../alertModel';

/**
 * The "Advanced" tab of step 2 — everything that shapes the NOTIFICATION.
 *
 *   ▌Additional Settings
 *   Template Override  ⓘ Learn more   [Select Template ⌄] ⟳
 *   Additional Variables ⓘ Learn more [Add Variable]
 *   Priority  ⓘ                       [Unset ⌄]
 *   Tags      ⓘ                       [Add tag and press Enter]
 *   Description                       [Type something]
 *   Row Template ⓘ   Template Type: [String][JSON]
 *
 * The reference's own second tab, in its own order. Every control writes a field
 * the one-screen editor already round-trips, so nothing here is new to the
 * document — what is new is that the WIZARD can now reach them. Before this,
 * creating an alert through the wizard and then wanting a priority on it meant
 * saving it, leaving, and reopening it in the editor.
 *
 * ─── Why it is a tab and not a third card ───────────────────────────────────
 *
 * None of it changes WHEN the alert fires, and all of it is optional. Put in
 * the same column as the conditions it would push the Settings card — which is
 * required, and half of the threshold's meaning — below the fold on a laptop.
 * The reference draws the same conclusion, and the asterisk on "Alert Rules"
 * against the bare "Advanced" is the whole distinction stated in one character.
 */

const IconRefresh = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 12a9 9 0 1 1-2.6-6.4" /><path d="M21 3v6h-6" />
  </svg>
);

const HELP = {
  template: 'The notification message that gets sent. Picking one here overrides '
    + "each destination's own template, for this alert only.",
  variables: 'Named values of your own. Write {name} in the template and it is '
    + 'filled in when the alert fires.',
  priority: 'How much this alert matters to your team. Used for filtering, sorting '
    + 'and notification routing — it does not affect when the alert fires.',
  tags: 'Labels for filtering and grouping alerts, e.g. prod or service:checkout. '
    + 'Lower-cased automatically; must start with a letter.',
  rowTemplate: 'An optional line rendered once per matching row inside the '
    + 'notification body, so the message can name what actually matched.',
};

const Help = ({ text }) => (
  <span className="aw-cond-help" title={text} aria-hidden="true">ⓘ</span>
);
Help.propTypes = { text: PropTypes.string.isRequired };

export default function AdvancedCard({ form, set, errors, showErr }) {
  /* ── templates ─────────────────────────────────────────────────────────── */

  const [templates, setTemplates] = useState([]);
  const [tplLoading, setTplLoading] = useState(false);

  const loadTemplates = (signal) => {
    setTplLoading(true);
    return fetchAlertTemplates({ signal })
      .then((res) => setTemplates(res.items || []))
      // The override is optional, so a failed list means "no override offered",
      // not a broken screen. Logged rather than surfaced.
      .catch((err) => { if (err.name !== 'AbortError') console.error('Templates unavailable:', err); })
      .finally(() => setTplLoading(false));
  };

  useEffect(() => {
    const controller = new AbortController();
    loadTemplates(controller.signal);
    return () => controller.abort();
     
  }, []);

  /* ── additional variables ──────────────────────────────────────────────── */

  const variables = form.variables || [];

  const setVariable = (key, fields) => set({
    variables: variables.map((v) => (v.key === key ? { ...v, ...fields } : v)),
  });

  const addVariable = () => set({
    variables: [...variables, { key: nextKey(), name: '', value: '' }],
  });

  const removeVariable = (key) => set({
    variables: variables.filter((v) => v.key !== key),
  });

  return (
    <>
      <div className="aw-card-head">
        <span className="aw-card-bar" aria-hidden="true" />{' '}
        Additional Settings
      </div>

      <div className="aw-card-body">
        {/* ── Template override ──────────────────────────────────────────
            Each destination already carries its own template; one chosen here
            overrides ALL of them, for this alert only. Left absent unless
            chosen, so an alert that relies on its destinations' templates keeps
            doing exactly that. */}
        <div className="aw-adv-block">
          <span className="aw-adv-label">
            Template Override
            <Help text={HELP.template} />
          </span>
          <div className="aw-cond-row aw-cond-row--bare">
            <select
              className="ae-select aw-adv-select"
              value={form.template}
              aria-label="Template override"
              onChange={(e) => set({ template: e.target.value })}
            >
              <option value="">
                {templates.length
                  ? 'Select Template — each destination uses its own'
                  : 'No templates available'}
              </option>
              {/* A template that has since been renamed or deleted stays
                  selectable, for the same reason a missing destination does:
                  silently switching the alert back to its destinations' own
                  templates would change what it sends. */}
              {form.template && !templates.some((t) => t.name === form.template) && (
                <option value={form.template}>{form.template} (missing)</option>
              )}
              {templates.map((t) => (
                <option key={t.name} value={t.name}>{t.name}</option>
              ))}
            </select>
            <button
              type="button" className="ae-icon-btn"
              onClick={() => loadTemplates()}
              disabled={tplLoading}
              title="Refresh the template list"
              aria-label="Refresh templates"
            ><IconRefresh /></button>
          </div>
        </div>

        {/* ── Additional variables — `context_attributes` ────────────────── */}
        <div className="aw-adv-block">
          <span className="aw-adv-label">
            Additional Variables
            <Help text={HELP.variables} />
          </span>
          <div className="ae-hint aw-adv-hint">
            Named values of your own. Write <code>{'{name}'}</code> in the template and
            it is filled in when the alert fires.
          </div>

          {variables.map((v) => (
            <div className="ae-varrow" key={v.key}>
              <input
                className="ae-input"
                value={v.name}
                placeholder="name"
                aria-label="Variable name"
                onChange={(e) => setVariable(v.key, { name: e.target.value })}
              />
              <input
                className="ae-input ae-input--grow"
                value={v.value}
                placeholder="value"
                aria-label={`Value for ${v.name || 'variable'}`}
                onChange={(e) => setVariable(v.key, { value: e.target.value })}
              />
              <button
                type="button" className="ae-warn-x"
                title="Remove variable"
                aria-label={`Remove variable ${v.name || ''}`}
                onClick={() => removeVariable(v.key)}
              >×</button>
            </div>
          ))}

          <div className="aw-cond-row aw-cond-row--bare">
            <button
              type="button" className="alerts-btn-ghost" onClick={addVariable}
            >Add Variable</button>
          </div>
          {showErr('variables') && <div className="ae-error">{errors.variables}</div>}
        </div>

        {/* ── Priority ───────────────────────────────────────────────────── */}
        <div className="aw-adv-block">
          <span className="aw-adv-label">
            Priority
            <Help text={HELP.priority} />
          </span>
          <div className="aw-cond-row aw-cond-row--bare">
            <select
              className="ae-select aw-adv-select aw-adv-select--narrow"
              value={form.priority}
              aria-label="Priority"
              onChange={(e) => set({ priority: e.target.value })}
            >
              <option value="">Unset</option>
              {PRIORITIES.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
            <span className="ae-hint">P1 is the most urgent.</span>
          </div>
        </div>

        {/* ── Tags ───────────────────────────────────────────────────────── */}
        <div className="aw-adv-block">
          <span className="aw-adv-label">
            Tags
            <Help text={HELP.tags} />
          </span>
          <TokenInput
            value={form.tags}
            onChange={(next) => set({ tags: next })}
            placeholder="Add tag and press Enter"
            ariaLabel="Tags"
            // Lower-cased on ENTRY rather than on save, so the chip the user
            // sees is the tag that actually gets stored.
            normalise={(raw) => (raw || '').trim().toLowerCase()}
          />
          {showErr('tags') && <div className="ae-error">{errors.tags}</div>}
        </div>

        {/* ── Description ────────────────────────────────────────────────── */}
        <div className="aw-adv-block">
          <label className="aw-adv-label" htmlFor="aw-adv-desc">Description</label>
          <textarea
            id="aw-adv-desc"
            className="ae-input aw-adv-textarea"
            value={form.description}
            placeholder="Type something — what this alert means and who should act on it"
            onChange={(e) => set({ description: e.target.value })}
          />
        </div>

        {/* ── Row template ───────────────────────────────────────────────── */}
        <div className="aw-adv-block">
          <div className="aw-adv-label-row">
            <label className="aw-adv-label" htmlFor="aw-adv-rowtpl">
              Row Template
              <Help text={HELP.rowTemplate} />
            </label>
            {/* Shown beside the field rather than under it, because it is a
                property OF the template rather than a separate setting — which
                is also why it stays hidden until a template exists to have a
                type. */}
            {(form.rowTemplate || '').trim() !== '' && (
              <span className="aw-adv-tpltype">
                <span className="aw-adv-tpltype-label">Template Type:</span>
                <span className="aw-seg aw-seg--mini" role="radiogroup" aria-label="Row template type">
                  {ROW_TEMPLATE_TYPES.map((t) => (
                    <button
                      key={t.value}
                      type="button"
                      role="radio"
                      aria-checked={form.rowTemplateType === t.value}
                      className={`aw-seg-btn ${form.rowTemplateType === t.value ? 'is-on' : ''}`}
                      onClick={() => set({ rowTemplateType: t.value })}
                    >{t.label}</button>
                  ))}
                </span>
              </span>
            )}
          </div>
          <textarea
            id="aw-adv-rowtpl"
            className="ae-input aw-adv-textarea"
            value={form.rowTemplate}
            placeholder="e.g - Alert was triggered at {timestamp}"
            onChange={(e) => set({ rowTemplate: e.target.value })}
          />
          {(form.rowTemplate || '').trim() !== '' && (
            <div className="ae-hint aw-adv-hint">
              {form.rowTemplateType === 'json'
                ? 'Rows are emitted as a JSON array.'
                : 'Rows are joined into one text block.'}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

AdvancedCard.propTypes = {
  /** The editor's form state — see alertModel.docToForm. */
  form: PropTypes.object.isRequired,
  /** Patch one or more form fields. */
  set: PropTypes.func.isRequired,
  /** Every validation error for the form, keyed by field. */
  errors: PropTypes.object.isRequired,
  /** Returns an error only once the field is worth complaining about. */
  showErr: PropTypes.func.isRequired,
};
