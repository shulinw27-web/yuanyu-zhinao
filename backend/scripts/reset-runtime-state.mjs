import { getRuntimeStoreInfo, resetRuntimeState } from '../src/repositories/runtime-state-repository.js';

const requestedNamespaces = process.argv.slice(2).filter((value) => !value.startsWith('-'));
resetRuntimeState(requestedNamespaces);
const target = requestedNamespaces.length ? requestedNamespaces.join(', ') : 'all namespaces';
process.stdout.write(`Runtime state reset: ${target} (${getRuntimeStoreInfo().driver})\n`);
