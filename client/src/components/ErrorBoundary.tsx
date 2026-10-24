import React from 'react';

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Ошибка рендера в одном компоненте не должна превращать всю панель в белый экран
 */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('Ошибка интерфейса:', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="min-h-screen bg-[#090a0f] flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-zinc-900 border border-red-500/30 rounded-2xl p-6 space-y-4 text-center">
          <h1 className="text-lg font-semibold text-white">Что-то пошло не так</h1>
          <p className="text-sm text-zinc-400 break-words">{this.state.error.message}</p>
          <button
            onClick={() => window.location.reload()}
            className="bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium px-5 py-2 rounded-xl transition"
          >
            Перезагрузить страницу
          </button>
        </div>
      </div>
    );
  }
}
