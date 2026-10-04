// Browser startup owner: preserve the classic Babel application global contract.
// Analyzer exports are assigned first; explicit helpers intentionally win collisions.
import * as analyzer from '../analyzer.js';
import { renderRepositoryGraph } from '../render/repositoryGraph.js';
import { renderFileGraph } from '../render/fileGraph.js';
import { installAlternateViewport, makeAlternateSelectable } from '../render/alternateViewport.js';
import { useRepositorySelection } from '../state/selection.js';
import { buildRepoUrl, readRouteRepo, writeRepoRoute, clearRoute } from '../state/route.js';
import { adaptRepositoryAnalysis } from '../adapters/repositoryGraphAdapter.js';
import { repositoryGraphToViewModel } from '../adapters/repositoryGraphToViewModel.js';
import { normalizeContext } from '../graph-ir/githubContext.js';
import { calcBlastFromGraph } from '../graph-ir/blastRadius.js';
import {
  tryCreateDrillDown,
  tryCreateDrillDownById,
  createSelectionEventForPath,
  tryCreateOpenSourceEvent,
  tryCreateOpenSourceEventById,
  githubBlobUrl,
} from '../state/repositoryDrillDown.js';
import { useRepositoryDrillDownPanel } from '../state/repositoryDrillDownPanel.js';
import { fetchFileGraph, GraphFileClientError } from '../state/graphFileClient.js';
import { fetchRepositoryGraph, GraphRepositoryClientError } from '../state/graphRepositoryClient.js';
import { renderFunctionGraph } from '../render/functionGraph.js';
import { buildFunctionRenderModel } from '../render/functionRenderModel.js';
import { fetchFunctionGraph, GraphFunctionClientError } from '../state/graphFunctionClient.js';
import { AnalysisSession } from '../state/analysisSession.js';
import { fetchCapabilities } from '../state/capabilitiesClient.js';
import { fetchBlame, fetchFileContentFromServer } from '../state/githubMetaClient.js';
Object.assign(window, analyzer, {
  renderRepositoryGraph, renderFileGraph, installAlternateViewport, makeAlternateSelectable, useRepositorySelection, buildRepoUrl, readRouteRepo, writeRepoRoute, clearRoute,
  adaptRepositoryAnalysis, repositoryGraphToViewModel, normalizeContext, calcBlastFromGraph,
  tryCreateDrillDown, tryCreateDrillDownById, createSelectionEventForPath, tryCreateOpenSourceEvent, tryCreateOpenSourceEventById, githubBlobUrl,
  useRepositoryDrillDownPanel,
  fetchFileGraph, GraphFileClientError,
  fetchRepositoryGraph, GraphRepositoryClientError,
  renderFunctionGraph, buildFunctionRenderModel, fetchFunctionGraph, GraphFunctionClientError,
  AnalysisSession,
  fetchCapabilities, fetchBlame, fetchFileContentFromServer,
});
