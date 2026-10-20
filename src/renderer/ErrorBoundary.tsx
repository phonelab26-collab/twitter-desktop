import { Component, type ErrorInfo, type ReactNode } from 'react';

/** A rendering bug shows a message and a reload button, never a blank window. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Twitter Desktop UI crashed:', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="notice notice-error crash" role="alert">
        <p className="notice-title">L'interface a rencontré une erreur.</p>
        <p className="notice-detail">{this.state.error.message}</p>
        <button type="button" className="button" onClick={() => window.location.reload()}>
          Recharger
        </button>
      </div>
    );
  }
}
