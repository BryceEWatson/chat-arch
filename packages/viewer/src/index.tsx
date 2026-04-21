import type { ChatArchViewerProps } from './ChatArchViewer.js';
import { ChatArchViewer as ChatArchViewerImpl } from './ChatArchViewer.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';

export type { ChatArchViewerProps };
export { BenchmarkRunner } from './components/BenchmarkRunner.js';

/**
 * Public entry — wraps the viewer in an ErrorBoundary so a render-time throw
 * (e.g. a malformed manifest that slipped past shape validation) renders the
 * LCARS TRANSMISSION ERROR fallback rather than unmounting the whole tree
 * and leaving the user with a blank page. See R12 F12.1.
 */
export function ChatArchViewer(props: ChatArchViewerProps) {
  return (
    <ErrorBoundary>
      <ChatArchViewerImpl {...props} />
    </ErrorBoundary>
  );
}
