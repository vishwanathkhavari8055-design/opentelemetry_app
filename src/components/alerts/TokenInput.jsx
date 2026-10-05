import React, { useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';

/**
 * A chip list you can type into — an editable array of short strings.
 *
 * Used for the alert editor's two free-form string lists: `tags`, and
 * deduplication's `fingerprint_fields`.
 *
 * ─── Why not CheckboxSelect or SearchableSelect ────────────────────────────
 *
 * Both of those pick from a KNOWN list, and neither of these fields has one:
 *
 *   • Tags have no option list at all. They are invented as they are needed.
 *   • Fingerprint fields are suggested from the stream's schema, but a stream
 *     that has not been written to reports no schema (see `fetchAlertStreamFields`),
 *     and OpenObserve's own control for this field is `creatable` — so a picker
 *     that can only offer what the schema returned would make the field
 *     unusable on exactly the streams where an alert is most likely to be new.
 *
 * So suggestions here are a convenience layered over free text, not the only way
 * in. That is the whole reason this component exists rather than a third caller
 * of one of the two selects.
 *
 * ─── Committing a token ────────────────────────────────────────────────────
 *
 * Enter, comma and blur all commit. Blur matters more than it looks: the natural
 * gesture after typing the last tag is to click Save, and a token still sitting
 * in the text box when the form serialises is a value the user believes they
 * entered silently vanishing.
 */
export default function TokenInput({
  value, onChange, suggestions, placeholder, ariaLabel, id, normalise, disabled,
}) {
  const [draft, setDraft] = useState('');
  const inputRef = useRef(null);
  const boxRef = useRef(null);

  // A click anywhere on the box (bar a chip's remove button) focuses the input,
  // so the whole field reads as one text box. Bound as a DOM listener: the box
  // is decoration, not a control a screen reader should announce.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return undefined;
    const onClick = (e) => {
      if (e.target.closest?.('.tki-chip-x')) return;
      inputRef.current?.focus();
    };
    box.addEventListener('click', onClick);
    return () => box.removeEventListener('click', onClick);
  }, []);

  const tokens = useMemo(() => value || [], [value]);

  /** Suggestions minus what is already chosen, so the list shrinks as you pick. */
  const available = useMemo(() => {
    const taken = new Set(tokens);
    return (suggestions || []).filter((s) => s && !taken.has(s));
  }, [suggestions, tokens]);

  const commit = (raw) => {
    const next = normalise ? normalise(raw) : (raw || '').trim();
    setDraft('');
    if (!next) return;
    // Silently ignoring a duplicate rather than erroring: re-typing a tag that
    // is already a chip is a no-op the user can see the result of.
    if (tokens.includes(next)) return;
    onChange([...tokens, next]);
  };

  const remove = (token) => onChange(tokens.filter((t) => t !== token));

  const onKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commit(draft);
      return;
    }
    // Backspace on an empty box removes the last chip — the standard gesture,
    // and the only way to undo a mis-typed token without reaching for a mouse.
    if (e.key === 'Backspace' && draft === '' && tokens.length) {
      e.preventDefault();
      onChange(tokens.slice(0, -1));
    }
  };

  return (
    <span className={`tki ${disabled ? 'is-disabled' : ''}`}>
      <span className="tki-box" ref={boxRef}>
        {tokens.map((token) => (
          <span className="tki-chip" key={token}>
            <span className="tki-chip-text">{token}</span>
            <button
              type="button"
              className="tki-chip-x"
              aria-label={`Remove ${token}`}
              title={`Remove ${token}`}
              disabled={disabled}
              onClick={(e) => { e.stopPropagation(); remove(token); }}
            >×</button>
          </span>
        ))}
        <input
          id={id}
          ref={inputRef}
          className="tki-input"
          value={draft}
          disabled={disabled}
          placeholder={tokens.length ? '' : placeholder}
          aria-label={ariaLabel}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => commit(draft)}
        />
      </span>

      {available.length > 0 && (
        <span className="tki-suggest">
          {/* Capped: a metrics stream here reports enough columns that rendering
              all of them would push the rest of the form off-screen. */}
          {available.slice(0, 8).map((s) => (
            <button
              type="button"
              className="tki-suggest-chip"
              key={s}
              disabled={disabled}
              onClick={() => commit(s)}
            >+ {s}</button>
          ))}
        </span>
      )}
    </span>
  );
}

TokenInput.propTypes = {
  value: PropTypes.arrayOf(PropTypes.string),
  onChange: PropTypes.func.isRequired,
  /** Offered as one-click chips below the box. Optional. */
  suggestions: PropTypes.arrayOf(PropTypes.string),
  placeholder: PropTypes.string,
  ariaLabel: PropTypes.string,
  id: PropTypes.string,
  /** Applied to every committed token, e.g. lower-casing a tag. */
  normalise: PropTypes.func,
  disabled: PropTypes.bool,
};
