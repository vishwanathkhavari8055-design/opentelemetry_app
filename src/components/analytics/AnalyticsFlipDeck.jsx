import React, { useCallback, useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import AnalyticsDashboardView from './AnalyticsDashboardView';
import AnalyticsCategoryBoardView from './AnalyticsCategoryBoardView';

/**
 * The Analytics Dashboard's two faces, and the flip between them.
 *
 * ─── Two presentations of one dataset ───────────────────────────────────────
 *
 * Both faces read /api/analytics/log-counts and report the same numbers. They differ
 * in the question they are shaped for:
 *
 *   FRONT — Drill Table    "show me this exact thing": three cascading pickers, a
 *                          sortable table, one row per level.
 *   BACK  — Category Board "where is the volume": every category on screen at once
 *                          with its share of the estate, click one to list everything
 *                          registered under it.
 *
 * Neither is a mode of the other and neither replaces the other. The Drill Table is
 * exactly the screen that existed before this deck was added — it was not rewritten
 * to fit here, it was wrapped.
 *
 * ─── Only the visible face is mounted ───────────────────────────────────────
 *
 * The obvious way to build a flip card is to put both faces in the DOM and rotate the
 * container. That is wrong here: each face polls OpenObserve on an interval, so a
 * permanently-mounted hidden face doubles the query load on the backing store to
 * animate something nobody is looking at.
 *
 * So the deck runs a three-step flip instead — rotate the current face out, swap it,
 * rotate the new one in — and only ever holds one. The cost is that the two halves of
 * the animation are separate; the benefit is that the invisible face costs nothing.
 *
 * ─── Flipping is not a reset ────────────────────────────────────────────────
 *
 * Swapping faces unmounts one, so the state that matters across a flip is persisted
 * rather than held here. The time range lives under ONE localStorage key that both
 * faces read and write, so the range you were looking at survives the flip — a flip
 * that silently changed the range would make the two faces disagree for a reason
 * nothing on screen explains. Drill path and card selection are each face's own and
 * deliberately not shared: they are not the same shape.
 *
 * ─── Reduced motion ────────────────────────────────────────────────────────
 *
 * The rotation is CSS, so `prefers-reduced-motion` flattens it to a plain swap in the
 * stylesheet. The timings here still run; they just have nothing to animate, which
 * keeps one state machine instead of two code paths.
 */

/** The faces, in flip order. Adding a third would work without touching the machine
 *  below — it cycles, and the toggle renders one button per entry. */
const FACES = [
  {
    key: 'table',
    label: 'Drill Table',
    hint: 'Cascading pickers and a sortable table — for when you know what you are looking for',
  },
  {
    key: 'board',
    label: 'Category Board',
    hint: 'Every category at once with its share of the estate — for finding where the volume is',
  },
];

/** Which face was last shown. Persisted because it is a preference about how somebody
 *  reads this screen, not navigation state — being returned to the table when you work
 *  from the board is a small papercut on every single visit. */
const LS_FACE = 'observability-ui:analytics:face:v1';

/** Half the flip. The face is swapped at this point, edge-on, so the change is not
 *  visible mid-rotation. Matches the .anf-stage transition duration in
 *  analytics-flip.css — they are two halves of one effect and must not drift. */
const HALF_FLIP_MS = 190;

export default function AnalyticsFlipDeck({ activeOrg, onNavigate, onDrillToLogs }) {
  const [face, setFace] = useState(() => {
    try {
      const stored = localStorage.getItem(LS_FACE);
      return FACES.some((f) => f.key === stored) ? stored : FACES[0].key;
    } catch { return FACES[0].key; }
  });

  /** 'idle' | 'out' | 'in'. Drives the rotation classes; the face is swapped on the
   *  transition from 'out' to 'in'. */
  const [phase, setPhase] = useState('idle');

  /** Pending timers, cleared on unmount so a flip in progress cannot call setState on
   *  an unmounted deck when somebody switches tabs mid-animation. */
  const timers = useRef([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  useEffect(() => {
    try { localStorage.setItem(LS_FACE, face); } catch { /* not persisted */ }
  }, [face]);

  const flipTo = useCallback((next) => {
    // Ignored rather than queued while a flip is running. Queueing would let a
    // double-click land the deck on a face nobody asked for.
    if (next === face || phase !== 'idle') return;

    setPhase('out');
    timers.current.push(setTimeout(() => {
      setFace(next);
      setPhase('in');
      // One frame after the swap, release to idle so the incoming face settles at 0°.
      timers.current.push(setTimeout(() => setPhase('idle'), HALF_FLIP_MS));
    }, HALF_FLIP_MS));
  }, [face, phase]);

  /** The other face — what the single Flip button targets. With two faces this is
   *  "the other one"; with more it is the next in the cycle. */
  const nextFace = FACES[(FACES.findIndex((f) => f.key === face) + 1) % FACES.length];

  return (
    <div className="anf-deck">
      {/* The toggle sits ABOVE the rotating stage, not inside it. A control that
          spins away mid-flip cannot be clicked again, and it has to stay put to read
          as the same control rather than part of the content. */}
      <div className="anf-bar">
        <h1 className="anf-title">Analytics</h1>

        <div className="anf-switch" role="tablist" aria-label="Analytics view">
          {FACES.map((entry) => (
            <button
              key={entry.key}
              type="button"
              role="tab"
              className={`anf-switch-btn ${entry.key === face ? 'is-active' : ''}`}
              aria-selected={entry.key === face}
              title={entry.hint}
              onClick={() => flipTo(entry.key)}
            >{entry.label}</button>
          ))}
        </div>

        {/* Both a named tab strip AND a blind flip. The strip is how you go to a
            specific face; this is how you flip back and forth comparing the two,
            which is the whole reason for a two-sided screen. */}
        <button
          type="button"
          className="anf-flip-btn"
          onClick={() => flipTo(nextFace.key)}
          disabled={phase !== 'idle'}
          title={`Flip to ${nextFace.label}`}
          aria-label={`Flip to ${nextFace.label}`}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3v18" />
            <path d="M7 7 3 12l4 5" />
            <path d="m17 7 4 5-4 5" />
          </svg>
          <span className="anf-flip-label">Flip</span>
        </button>
      </div>

      <div className={`anf-stage is-${phase}`}>
        {/* Keyed by face AND org: switching tenant must rebuild the face rather than
            let a stale row report another org's volume, and keying by face means the
            incoming view mounts fresh instead of inheriting the outgoing one's state
            through a shared slot. */}
        {/* Both faces get the drill unchanged. A count means the same thing on
            either side, so it has to lead to the same place from either side. */}
        {face === 'table' && (
          <AnalyticsDashboardView
            key={`table-${activeOrg || 'default'}`}
            activeOrg={activeOrg}
            onNavigate={onNavigate}
            onDrillToLogs={onDrillToLogs}
          />
        )}
        {face === 'board' && (
          <AnalyticsCategoryBoardView
            key={`board-${activeOrg || 'default'}`}
            activeOrg={activeOrg}
            onNavigate={onNavigate}
            onDrillToLogs={onDrillToLogs}
          />
        )}
      </div>
    </div>
  );
}

AnalyticsFlipDeck.propTypes = {
  /** Passed through to both faces, which key off it — the Product Catalog behind
   *  every row is a per-tenant registry. */
  activeOrg: PropTypes.string,
  /** (tab) — used by both faces for the "Open Product Catalog" jump. */
  onNavigate: PropTypes.func,
  /** ({services, severity, range}) — opens Logs filtered to a clicked count.
   *  Routed straight through; the faces build the filter, the shell navigates. */
  onDrillToLogs: PropTypes.func,
};
