import { Component, type ReactNode } from 'react';
import { ErrorState } from './ErrorState.js';

export interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Top-level error boundary. Fallback UI matches the LCARS TRANSMISSION ERROR
 * treatment rather than an unstyled browser default.
 *
 * See R12 F12.1 — a malformed manifest threw during render and unmounted the
 * whole React tree because no boundary was in place.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override render() {
    if (this.state.error) {
      return (
        <div className="lcars-root" data-tier="desktop">
          <div className="lcars-frame">
            <ErrorState
              title="TRANSMISSION ERROR"
              detail={`The viewer hit an unrecoverable error: ${this.state.error.message}`}
            />
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
