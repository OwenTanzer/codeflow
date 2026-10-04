// The classic worker reads its owning module's source via import.meta.url.
// Keep that one module byte-for-byte intact; minifying its marker-delimited
// body removes the names used by the worker bootstrap. All other modules
// continue through the normal Vite pipeline.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const analyzerPath = fileURLToPath(new URL('../src/analyzer.js', import.meta.url));

export function preserveAnalyzerSource() {
  let source, fileName, assetsDir;
  return {
    name: 'codeflow-preserve-analyzer-source',
    apply: 'build',
    enforce: 'pre',
    configResolved(config) { assetsDir = config.build.assetsDir; },
    buildStart() {
      source = readFileSync(analyzerPath);
      fileName = `analyzer-${createHash('sha256').update(source).digest('hex').slice(0, 16)}.js`;
      this.addWatchFile(analyzerPath);
    },
    resolveId(id, importer) {
      if (id === analyzerPath || (importer && resolve(dirname(importer), id) === analyzerPath)) {
        // Both this external import and the entry chunk live in assetsDir.
        return { id: `./${fileName}`, external: true };
      }
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: `${assetsDir}/${fileName}`, source });
    },
  };
}
