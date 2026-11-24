import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Clear a captured error when the user moves to a different entity / query. */
  resetKey?: string;
  /** `error` is whatever was thrown, which is not always an Error. */
  fallback: ReactNode | ((retry: () => void, error: unknown) => ReactNode);
}

interface State {
  // A flag of its own because the thrown value can be falsy (`throw undefined`,
  // or a lazy import rejected with no reason). Testing `error` alone rendered
  // the children again and let that throw escape to the page boundary.
  hasError: boolean;
  error: unknown;
}

/**
 * Last-resort catch for a render throw. Memory has no route errorElement, so a
 * crash in TimelineJS or the detail drawer used to white-screen the explorer.
 */
export class ViewCrashBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { hasError: true, error };
  }

  componentDidUpdate(prevProps: Props): void {
    if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false, error: null });
    }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('ViewCrashBoundary', error, info.componentStack);
  }

  retry = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      const { fallback } = this.props;

      return typeof fallback === 'function' ? fallback(this.retry, this.state.error) : fallback;
    }

    return this.props.children;
  }
}
