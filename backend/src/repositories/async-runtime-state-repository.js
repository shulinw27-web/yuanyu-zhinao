import * as synchronousRepository from './runtime-state-repository.js';

// Transitional async port. Current Memory/SQLite operations are synchronous,
// but application services consume this Promise-based contract so PostgreSQL
// can be injected without changing domain behavior a second time.
export const asyncRuntimeStateRepository = Object.freeze({
  readState: async (...args) => synchronousRepository.readState(...args),
  writeState: async (...args) => synchronousRepository.writeState(...args),
  mutateState: async (...args) => synchronousRepository.mutateState(...args),
  mutateStates: async (...args) => synchronousRepository.mutateStates(...args),
  listState: async (...args) => synchronousRepository.listState(...args),
  deleteState: async (...args) => synchronousRepository.deleteState(...args),
  resetRuntimeState: async (...args) => synchronousRepository.resetRuntimeState(...args),
  probe: async () => ({ ready: true }),
  getInfo: () => synchronousRepository.getRuntimeStoreInfo()
});
