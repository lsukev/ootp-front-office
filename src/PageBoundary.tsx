import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Keeps one broken page from taking the window with it.
 *
 * A reader opened the draft board and got a blank screen — not an error, not a
 * spinner, nothing, and no navigation left to go anywhere else. React unmounts
 * the whole tree when a render throws and nothing catches it, so a single bad
 * read on one page cost him the entire app and left him with no way back but
 * quitting. The fault was a real one and is fixed; being unable to leave the
 * page was the worse half of it, and that half was every page's problem.
 *
 * So the failure is contained to the page, the navigation above it keeps
 * working, and the message says what actually went wrong. Everything here runs
 * against a file on the reader's own machine, so there is nothing to protect by
 * withholding it — and a specific sentence is one he can report, which is how
 * the last three of these were diagnosed in a single round-trip instead of
 * three.
 *
 * Keyed by page in App, so moving to another page and back gets a clean mount
 * rather than the error stubbornly persisting.
 */
interface Props {
  children: ReactNode;
  /** Where to send the reader when this page will not render. */
  onLeave: () => void;
}

interface State {
  error: Error | null;
}

export class PageBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The stack is worth more than the message when somebody sends a report
    console.error('[page] render failed:', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="hint">
        <h3>This page could not be drawn</h3>
        <p>
          Something on it went wrong: <strong>{error.message}</strong>
        </p>
        <p className="muted">
          The rest of the app is fine — use the navigation above, or the button below. If it happens
          again, that message is worth reporting; it says exactly what broke.
        </p>
        <button className="cta" onClick={() => { this.setState({ error: null }); this.props.onLeave(); }}>
          Back to the dashboard
        </button>
      </div>
    );
  }
}
