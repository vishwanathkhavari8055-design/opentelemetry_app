// ---------------------------------------------------------------------------
// propTypes for the PanelPlugin render functions in this folder.
//
// Nothing in this application calls those components: Grafana's VizPanel builds
// their props from its PanelProps contract. So these describe that contract
// loosely — `options` and `fieldConfig` are whatever the dashboard's JSON put
// there, and a prop Grafana adds later is simply not validated, never rejected.
// ---------------------------------------------------------------------------

import PropTypes from 'prop-types';

export const panelPropTypes = {
  data: PropTypes.object,
  width: PropTypes.number,
  height: PropTypes.number,
  options: PropTypes.object,
  fieldConfig: PropTypes.object,
  timeRange: PropTypes.object,
  timeZone: PropTypes.string,
  title: PropTypes.string,
  onChangeTimeRange: PropTypes.func,
  replaceVariables: PropTypes.func,
  renderCounter: PropTypes.number,
};

// The "No data" / "Query error" filler each panel file renders in place of a
// visualization.
export const centeredPropTypes = {
  width: PropTypes.number,
  height: PropTypes.number,
  children: PropTypes.node,
  tone: PropTypes.oneOf(['muted', 'error']),
};
