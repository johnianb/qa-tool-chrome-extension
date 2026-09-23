/**
 * Catches render and effect errors in the review page.
 *
 * Without a boundary React unmounts the root on any uncaught error, so a single
 * malformed session record produces a blank white page with nothing to go on. Showing
 * the message costs one component and saves an afternoon.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[qa-bug-reporter] review page crashed', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="max-w-lg">
          <h1 className="text-lg font-semibold">The review page hit an error</h1>
          <p className="mt-2 text-sm text-neutral-600">
            Your recordings are still stored. Reload the page; if it keeps failing, the
            message below and the DevTools console will say which record is at fault.
          </p>
          <pre className="mt-4 overflow-x-auto rounded-lg bg-neutral-100 p-3 text-xs text-red-700">
            {error.message}
          </pre>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="mt-4 rounded-lg border border-neutral-300 px-3 py-1.5 text-sm hover:border-neutral-500"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
}
