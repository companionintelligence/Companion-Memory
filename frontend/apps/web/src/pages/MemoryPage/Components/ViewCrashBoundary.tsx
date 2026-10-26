import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Clear a captured error when the user moves to a different entity / query. */
  resetKey?: string;
  fallback: ReactNode | ((retry: () => void, error: Error) => ReactNode);
}

interface State {
  error: Error | null;
}

/**
 * Last-resort catch for a render throw. Memory has no route errorElement, so a
 * crash in TimelineJS or the detail drawer used to white-screen the explorer.
 */
export class ViewCrashBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prevProps: Props): void {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('ViewCrashBoundary', error, info.componentStack);
  }

  retry = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (this.state.error) {
      const { fallback } = this.props;

      return typeof fallback === 'function' ? fallback(this.retry, this.state.error) : fallback;
    }

    return this.props.children;
  }
}
