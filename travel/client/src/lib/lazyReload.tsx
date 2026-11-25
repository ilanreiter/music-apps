import React from "react";

/**
 * React.lazy that survives a rebuild: a tab opened before the rebuild asks for the old hashed file, which no longer
 * exists. The first time that happens the page reloads to pick up the new build; if it still fails, the error goes to
 * the nearest LazyBoundary instead of blanking the whole page.
 */
export function lazyWithReload<T extends React.ComponentType<any>>(load: () => Promise<{ default: T }>) {
  return React.lazy(() =>
    load()
      .then((m) => { try { sessionStorage.removeItem("wander-chunk-reload"); } catch {} return m; })
      .catch((err) => {
        let reloaded = false;
        try { reloaded = sessionStorage.getItem("wander-chunk-reload") === "1"; sessionStorage.setItem("wander-chunk-reload", "1"); } catch {}
        if (!reloaded) { window.location.reload(); return new Promise<{ default: T }>(() => {}); }
        throw err;
      })
  );
}

/** Shows a small message in place of a lazily loaded part that could not load. */
export class LazyBoundary extends React.Component<{ children: React.ReactNode; label?: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="flex h-[200px] flex-col items-center justify-center gap-2 rounded-lg border border-slate-200 text-sm text-slate-500 dark:border-slate-800">
        {this.props.label ?? "This part of the page couldn't load."}
        <button type="button" onClick={() => window.location.reload()} className="text-brand-600 hover:underline">Reload the page</button>
      </div>
    );
  }
}
