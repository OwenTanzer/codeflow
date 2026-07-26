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
    // MOO-71 Commit 8: a function-layer entry is labelled by the symbol it
    // actually opened, not by its file path -- several functions in one file
    // would otherwise produce a breadcrumb trail of identical-looking
    // segments ("sessions.py / sessions.py").
    const label =
      event.targetLayer === 'function' && event.coordinate.symbolPath && event.coordinate.symbolPath.length > 0
        ? event.coordinate.symbolPath.join('.')
        : event.coordinate.path;
    historyRef.current.push(makeBreadcrumbEntry(event.targetLayer, event.coordinate, { label }));
    forceRender();
  }, []);

  // MOO-71 Commit 8: how a panel records the state its history entry should
  // be restored to -- the cache key of the graph it loaded, and the selected
  // node. Deliberately records against whichever entry is current *now*, so
  // a late-arriving response cannot write its state onto an entry the user
  // has already navigated away from.
  const recordPanelState = React.useCallback((patch) => {
    historyRef.current.updateCurrent(patch);
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
    recordPanelState,
  };
}
