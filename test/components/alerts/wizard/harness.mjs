/**
 * Shared scaffolding for the wizard's card tests: the cards are controlled
 * (`form` + `set`), so a test needs a parent that actually holds the form and
 * re-renders on `set` — otherwise a typed value never reaches the screen and
 * nothing a user does can be asserted on.
 *
 * Import AFTER ../../../support/dom.mjs.
 */
const React = (await import('react')).default;
const { docToForm, emptyAlertDoc } = await import('../../../../src/components/alerts/alertModel.js');

export const baseForm = (patch = {}) => ({ ...docToForm(emptyAlertDoc()), ...patch });

/**
 * Renders `Component` inside a stateful parent. `latest.form` always holds the
 * current form, and `latest.patches` every patch `set` received, in order.
 */
export function makeHarness(Component, { form = baseForm(), errors = {}, shown = () => true, extra = {} } = {}) {
  const latest = { form, patches: [] };
  function Harness() {
    const [state, setState] = React.useState(form);
    latest.form = state;
    const set = (patch) => {
      latest.patches.push(patch);
      setState((prev) => ({ ...prev, ...patch }));
    };
    return React.createElement(Component, {
      form: state, set, errors, showErr: (field) => shown(field) && !!errors[field], ...extra,
    });
  }
  return { element: React.createElement(Harness), latest };
}

export const API = '/OpentelemetryService/api';
