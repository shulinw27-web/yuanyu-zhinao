import { processDomainEventBatch } from '../../backend/src/workers/domain-event-worker.js';
import { createConfiguredWorkerBroker } from './worker-config.js';
import { createPostgresRuntimeStateRepository } from '../../backend/src/repositories/postgres-runtime-state-repository.js';
import { PostgresDomainEventStore } from '../../backend/src/infrastructure/domain-events/postgres-domain-event-store.js';

const intervalMs = Math.max(500, Number(process.env.EVENT_WORKER_INTERVAL_MS) || 2000);
const broker = createConfiguredWorkerBroker();
const postgresRepository = process.env.DOMAIN_EVENT_STORE_DRIVER === 'postgres' ? await createPostgresRuntimeStateRepository() : null;
const eventStore = postgresRepository ? new PostgresDomainEventStore(postgresRepository) : null;
const runOnce = async () => {
  const result = await processDomainEventBatch({
    consumerId: process.env.EVENT_WORKER_CONSUMER_ID || 'internal-projection-worker',
    tenantId: process.env.EVENT_WORKER_TENANT_ID || 'demo-enterprise',
    limit: Number(process.env.EVENT_WORKER_BATCH_SIZE) || 20,
    broker,
    eventStore
  });
  if (result.claimed || result.failed) console.log(JSON.stringify({ service: 'domain-event-worker', ...result }));
  return result;
};

if (process.env.EVENT_WORKER_ONCE === 'true' || process.argv.includes('--once')) {
  await runOnce();
  await postgresRepository?.close();
} else {
  console.log(JSON.stringify({ service: 'domain-event-worker', event: 'worker_started', intervalMs, broker: broker.getHealth() }));
  await runOnce();
  const timer = setInterval(() => runOnce().catch((error) => console.error('Domain event worker cycle failed', error.message)), intervalMs);
  const stop = async () => { clearInterval(timer); await postgresRepository?.close(); process.exit(0); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
