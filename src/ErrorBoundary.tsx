import { Component, type ReactNode } from 'react';
export default class ErrorBoundary extends Component<{ children: ReactNode; fallback?: ReactNode }, { error: string | null }> {
  state: { error: string | null } = { error: null };
  static getDerivedStateFromError(error: unknown) { return { error: String(error) }; }
  render() {
    if (!this.state.error) return this.props.children;
    return <div className="recovery" role="alert"><h2>This view could not start</h2><pre>{this.state.error}</pre>{this.props.fallback}<button onClick={() => location.reload()}>Reload AfterEdit</button></div>;
  }
}
