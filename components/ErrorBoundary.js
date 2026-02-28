import React from 'react';

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error('ErrorBoundary caught:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="card p-6 text-center space-y-3">
          <p className="text-sm font-medium text-red-700">Something went wrong in this view</p>
          <p className="text-xs text-stone-500">{this.state.error?.message || 'Unknown error'}</p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="text-xs px-3 py-1 bg-stone-900 text-white rounded hover:bg-stone-800"
          >
            Try Again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
