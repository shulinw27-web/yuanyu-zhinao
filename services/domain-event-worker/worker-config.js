import { createDomainEventBroker } from '../../backend/src/infrastructure/domain-events/brokers/domain-event-broker.js';

export function createConfiguredWorkerBroker(env = process.env, dependencies = {}) {
  const type = String(env.EVENT_BROKER_TYPE || 'projection').trim().toLowerCase();
  if (type === 'projection') return createDomainEventBroker({ type, handler: dependencies.projectionHandler });
  if (type === 'webhook') return createDomainEventBroker({
    type,
    webhook: {
      endpoint: env.EVENT_WEBHOOK_URL,
      signingSecret: env.EVENT_WEBHOOK_SIGNING_SECRET,
      timeoutMs: env.EVENT_WEBHOOK_TIMEOUT_MS,
      requireHttps: env.NODE_ENV === 'production',
      fetchImpl: dependencies.fetchImpl
    }
  });
  const publisher = dependencies.publisherByType?.[type];
  if (type === 'kafka') return createDomainEventBroker({ type, publisher, kafka: {
    brokers: env.EVENT_KAFKA_BROKERS, topic: env.EVENT_KAFKA_TOPIC,
    clientId: env.EVENT_KAFKA_CLIENT_ID, ssl: env.EVENT_KAFKA_SSL === 'true',
    username: env.EVENT_KAFKA_USERNAME, password: env.EVENT_KAFKA_PASSWORD
  } });
  if (type === 'rabbitmq') return createDomainEventBroker({ type, publisher, rabbitmq: {
    url: env.EVENT_RABBITMQ_URL, exchange: env.EVENT_RABBITMQ_EXCHANGE
  } });
  return createDomainEventBroker({ type, publisher });
}
