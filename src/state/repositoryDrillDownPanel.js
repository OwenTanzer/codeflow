// Drill-down breadcrumb/history + placeholder panel state — MOO-69 Commit 4.
//
// MOO-70 (the pyan3 file layer) doesn't exist yet, so there is nowhere real
// to navigate a repository -> file drill-down to. This hook wires the real
// navigation contract (src/graph-ir/navigation.js's NavigationHistory,
// breadcrumbs, back/forward) end-to-end regardless, opening a lightweight
// placeholder panel showing the resolved drill-down event instead of a real
// file-layer view — MOO-70 swaps the placeholder for a real view later
// without needing to touch this history/breadcrumb plumbing again.
//
// `React` is read as an ambient global (window.React), same pattern
// src/state/selection.js and src/state/route.js use.
/* eslint-disable no-undef */
import { NavigationHistory, makeBreadcrumbEntry } from '../graph-ir/navigation.js';

const ROOT_ENTRY_LABEL = 'Repository';

function makeRootEntry() {
  return makeBreadcrumbEntry('repository', null, { label: ROOT_ENTRY_LABEL });
}

export function useRepositoryDrillDownPanel() {
  const historyRef = React.useRef(null);
  const [, forceRender] = React.useReducer((c) => c + 1, 0);

  if (!historyRef.current) {
    historyRef.current = new NavigationHistory(makeRootEntry());
  }
  const history = historyRef.current;

  const openDrillDown = React.useCallback((event) => {
    historyRef.current.push(
      makeBreadcrumbEntry(event.targetLayer, event.coordinate, { label: event.coordinate.path })
    );
    forceRender();
  }, []);

  const goBack = React.useCallback(() => {
    if (historyRef.current.canGoBack) {
      historyRef.current.back();
      forceRender();
    }
  }, []);

  const goForward = React.useCallback(() => {
    if (historyRef.current.canGoForward) {
      historyRef.current.forward();
      forceRender();
    }
  }, []);

  const resetHistory = React.useCallback(() => {
    historyRef.current = new NavigationHistory(makeRootEntry());
    forceRender();
  }, []);

  const trail = history.trail();
  const current = history.current();
  const panel = current.layer !== 'repository' ? current : null;

  return {
    trail,
    panel,
    canGoBack: history.canGoBack,
    canGoForward: history.canGoForward,
    openDrillDown,
    goBack,
    goForward,
    resetHistory,
  };
}
