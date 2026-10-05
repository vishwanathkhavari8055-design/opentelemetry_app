import React, { Component } from 'react';
import PropTypes from 'prop-types';

/**
 * Error boundary around the rendered scene.
 *
 * @grafana/scenes builds a deep React tree out of data this application does not
 * control: dashboard JSON authored in Grafana by other teams, panel options from
 * a plugin we may only partly implement, and query results from a datasource that
 * can return anything. React 18 tears down the ENTIRE root when an error escapes,
 * so without this one bad panel would blank the whole application — rail, header,
 * Logs, Alerts and all.
 *
 * The app already has a root ErrorBoundary (components/common/ErrorBoundary), and
 * that is exactly why this one is here as well: the root boundary's job is "the
 * app crashed", and it would be reached for something that should cost nothing
 * more than this one dashboard view.
 */
export default class SceneErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[dashboards] scene rendering failed', error, info?.componentStack);
  }

  componentDidUpdate(prevProps) {
    // A different dashboard, or an explicit reload, deserves a clean attempt —
    // otherwise the boundary would keep showing the previous failure over content
    // that has since changed.
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="gd-state gd-state--error" role="alert">
        <span className="gd-state-title">This dashboard could not be rendered</span>
        <span className="gd-state-detail">{error.message || String(error)}</span>
        <span className="gd-state-hint">
          The rest of the application is unaffected — open another dashboard, or try again.
        </span>
        <button
          type="button"
          className="alerts-btn-primary"
          onClick={() => this.setState({ error: null })}
        >
          Try again
        </button>
      </div>
    );
  }
}

SceneErrorBoundary.propTypes = {
  /** Change this to clear a previous failure — the dashboard uid plus a reload counter. */
  resetKey: PropTypes.string,
  children: PropTypes.node,
};
