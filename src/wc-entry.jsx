import React from 'react';
import PropTypes from 'prop-types';
import ReactDOM from 'react-dom/client';
import ErrorBoundary from './components/common/ErrorBoundary';
import LogsView from './components/LogsView';
import TraceView from './components/TraceView';
import SummaryView from './components/SummaryView';
import styles from './index.css?inline'; // Using Vite's inline CSS loading for Shadow DOM
import { setApiBase } from './services/api';

/**
 * Verifies that the given api-base-url is valid by probing its /healthz endpoint.
 */
const verifyLibContract = async (apiBase) => {
  if (!apiBase) return;
  const base = apiBase.replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/healthz`, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      console.warn(
        `[observability-ui] api-base-url ${base} returned HTTP ${res.status} on /healthz. ` +
        `Expected the observability-lib REST API. UI may not render correctly.`
      );
      return;
    }
    const body = await res.json();
    if (body?.service !== 'observability-lib') {
      console.warn(
        `[observability-ui] api-base-url ${base} responded to /healthz but did not identify ` +
        `as observability-lib (got ${JSON.stringify(body)}). The UI talks ONLY to the lib's ` +
        `REST API; ensure your api-base-url points at it.`
      );
      return;
    }
    console.info(
      `[observability-ui] connected to observability-lib at ${base} ` +
      `(backend=${body.backend ?? 'unknown'})`
    );
  } catch (err) {
    console.warn(
      `[observability-ui] could not reach ${base}/healthz: ${err?.message ?? err}. ` +
      `Verify api-base-url points at a running observability-lib.`
    );
  }
};

/**
 * React Wrapper for Logs + Trace view.
 */
const LogsApp = ({ servicePrefill, onServicePrefillConsumed }) => {
  const [mode, setMode] = React.useState('logs');
  const [selectedTraceId, setSelectedTraceId] = React.useState(null);
  const [hoveredTraceId, setHoveredTraceId] = React.useState(null);
  const [logsPage, setLogsPage] = React.useState(0);
  const [logsPageSize, setLogsPageSize] = React.useState(10);

  const handleTraceClick = (traceId) => {
    setSelectedTraceId(traceId);
    setMode('trace');
  };

  const handleBackToLogs = () => {
    setMode('logs');
    setSelectedTraceId(null);
  };

  return (
    <main className="container">
      {mode === 'logs' ? (
        <LogsView
          onTraceClick={handleTraceClick}
          hoveredTraceId={hoveredTraceId}
          setHoveredTraceId={setHoveredTraceId}
          page={logsPage}
          setPage={setLogsPage}
          pageSize={logsPageSize}
          setPageSize={setLogsPageSize}
          servicePrefill={servicePrefill}
          onServicePrefillConsumed={onServicePrefillConsumed}
        />
      ) : (
        <TraceView
          traceId={selectedTraceId}
          onBack={handleBackToLogs}
        />
      )}
    </main>
  );
};

LogsApp.propTypes = {
  servicePrefill: PropTypes.string,
  onServicePrefillConsumed: PropTypes.func,
};

/**
 * Shared shell for both custom elements: a shadow root carrying the app's
 * stylesheet, one React root mounted into it, and the api-base-url attribute
 * wired to the API client. Subclasses supply `renderApp()`.
 */
class ShadowReactElement extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.root = null;
  }

  connectedCallback() {
    this.render();
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue !== newValue) {
      if (name === 'api-base-url') {
        setApiBase(newValue);
      }
      this.render();
    }
  }

  disconnectedCallback() {
    if (this.root) {
      this.root.unmount();
      this.root = null;
    }
  }

  render() {
    if (!this.root) {
      // 1. Inject Styles into Shadow DOM
      const styleTag = document.createElement('style');
      styleTag.textContent = styles;
      this.shadowRoot.appendChild(styleTag);

      // 2. Create Mount Point
      const mountPoint = document.createElement('div');
      mountPoint.id = 'wc-root';
      mountPoint.style.width = '100%';
      mountPoint.style.minHeight = '100%';
      mountPoint.style.backgroundColor = 'var(--bg-color)';
      mountPoint.style.display = 'flex';
      mountPoint.style.flexDirection = 'column';
      this.shadowRoot.appendChild(mountPoint);

      // 3. Initialize React
      this.root = ReactDOM.createRoot(mountPoint);
    }

    // 4. Update configuration from attributes safely
    const apiBase = this.getAttribute('api-base-url');
    if (apiBase) {
      setApiBase(apiBase);
    }

    const app = this.renderApp();

    // 5. Contract check — non-blocking; only warns.
    verifyLibContract(apiBase);

    this.root.render(
      <React.StrictMode>
        <ErrorBoundary>
          {app}
        </ErrorBoundary>
      </React.StrictMode>
    );
  }
}

/**
 * Web Component wrapper for the Observability Logs/Trace UI.
 */
class ObservabilityUI extends ShadowReactElement {
  static get observedAttributes() {
    return ['api-base-url', 'service-prefill'];
  }

  renderApp() {
    const servicePrefill = this.getAttribute('service-prefill');
    return (
      <LogsApp
        servicePrefill={servicePrefill}
        onServicePrefillConsumed={() => {
          this.removeAttribute('service-prefill');
        }}
      />
    );
  }
}

/**
 * React Wrapper for Summary view.
 */
const SummaryApp = ({ onDrillToService }) => {
  return (
    <main className="container">
      <SummaryView onDrillToService={onDrillToService} />
    </main>
  );
};

SummaryApp.propTypes = {
  onDrillToService: PropTypes.func,
};

/**
 * Web Component wrapper for the Observability Dashboard Summary UI.
 */
class ObservabilitySummary extends ShadowReactElement {
  static get observedAttributes() {
    return ['api-base-url'];
  }

  renderApp() {
    return (
      <SummaryApp
        onDrillToService={(serviceName) => {
          this.dispatchEvent(new CustomEvent('drill-to-service', {
            detail: { serviceName },
            bubbles: true,
            composed: true
          }));
        }}
      />
    );
  }
}

// Register custom elements
if (!customElements.get('observability-ui')) {
  customElements.define('observability-ui', ObservabilityUI);
}
if (!customElements.get('observability-summary')) {
  customElements.define('observability-summary', ObservabilitySummary);
}
