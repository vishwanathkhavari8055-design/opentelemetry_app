import React from 'react';
import PropTypes from 'prop-types';

/**
 * ErrorBoundary for standard React error isolation.
 * Prevents internal crashes from breaking the host environment in embedded modes.
 */
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("Observability UI Error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          padding: '2rem',
          backgroundColor: '#1a1a1e',
          color: '#ef5350',
          borderRadius: '8px',
          border: '1px solid #c62828',
          fontFamily: 'sans-serif'
        }}>
          <h3>Something went wrong</h3>
          <p>The Observability module encountered an error.</p>
          <button 
            onClick={() => window.location.reload()}
            style={{
              padding: '0.5rem 1rem',
              backgroundColor: '#c62828',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer'
            }}
          >
            Reload Module
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

ErrorBoundary.propTypes = {
  children: PropTypes.node,
};

export default ErrorBoundary;
