export class DomainEventBroker {
  constructor(type) {
    this.type = type;
  }

  async publish() {
    throw new Error('DomainEventBroker.publish must be implemented.');
  }

  getHealth() {
    return { type: this.type, status: 'unknown' };
  }
}

export class ProjectionBrokerAdapter extends DomainEventBroker {
  constructor(handler = async () => {}) {
    super('projection');
    this.handler = handler;
  }

  async publish(event) {
    await this.handler(structuredClone(event));
    return { accepted: true, broker: this.type, eventId: event.eventId };
  }

  getHealth() {
    return { type: this.type, status: 'healthy', durable: false };
  }
}

export class CallbackBrokerAdapter extends DomainEventBroker {
  constructor(type, publisher) {
    if (typeof publisher !== 'function') throw new Error(`${type} broker requires an injected publisher.`);
    super(type);
    this.publisher = publisher;
  }

  async publish(event) {
    const result = await this.publisher(structuredClone(event));
    return { accepted: true, broker: this.type, eventId: event.eventId, result };
  }

  getHealth() {
    return { type: this.type, status: 'configured', durable: true };
  }
}

export class WebhookBrokerAdapter extends DomainEventBroker {
  constructor({ endpoint, signingSecret, fetchImpl = globalThis.fetch, timeoutMs = 10_000, requireHttps = process.env.NODE_ENV === 'production' } = {}) {
    super('webhook');
    let parsed;
    try { parsed = new URL(endpoint); } catch { throw new Error('Webhook broker requires a valid endpoint URL.'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || (requireHttps && parsed.protocol !== 'https:')) throw new Error('Webhook broker endpoint must use HTTPS in production.');
    if (!signingSecret || String(signingSecret).length < 16) throw new Error('Webhook broker requires a signing secret of at least 16 characters.');
    if (typeof fetchImpl !== 'function') throw new Error('Webhook broker requires a fetch implementation.');
    this.endpoint = parsed.toString();
    this.signingSecret = String(signingSecret);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = Math.min(Math.max(Number(timeoutMs) || 10_000, 1_000), 30_000);
  }

  async publish(event) {
    const body = JSON.stringify(event);
    const signature = createHmac('sha256', this.signingSecret).update(body).digest('hex');
    let response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/cloudevents+json',
          'ce-specversion': '1.0', 'ce-id': event.eventId, 'ce-type': event.type,
          'ce-source': 'healthcare-ai-demo-platform', 'idempotency-key': event.eventId,
          'x-event-signature': `sha256=${signature}`
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      const failure = new Error('Webhook broker delivery failed.');
      failure.code = error?.name === 'TimeoutError' ? 'WEBHOOK_BROKER_TIMEOUT' : 'WEBHOOK_BROKER_UNAVAILABLE';
      throw failure;
    }
    if (!response?.ok) {
      const failure = new Error('Webhook broker rejected the event.');
      failure.code = `WEBHOOK_BROKER_HTTP_${Number(response?.status || 0)}`;
      throw failure;
    }
    return { accepted: true, broker: this.type, eventId: event.eventId, statusCode: response.status };
  }

  getHealth() {
    return { type: this.type, status: 'configured', durable: true, endpointOrigin: new URL(this.endpoint).origin };
  }
}

export class KafkaBrokerAdapter extends DomainEventBroker {
  constructor({ brokers, topic, clientId = 'healthcare-ai-domain-event-worker', ssl = false, username, password } = {}) {
    super('kafka');
    this.brokers = Array.isArray(brokers) ? brokers.filter(Boolean) : String(brokers || '').split(',').map((item) => item.trim()).filter(Boolean);
    if (!this.brokers.length || !topic) throw new Error('Kafka broker requires brokers and topic.');
    if ((username && !password) || (!username && password)) throw new Error('Kafka SASL username and password must be configured together.');
    this.topic = String(topic);
    this.clientId = String(clientId);
    this.ssl = Boolean(ssl);
    this.sasl = username ? { mechanism: 'plain', username: String(username), password: String(password) } : undefined;
    this.producerPromise = null;
  }

  async getProducer() {
    if (!this.producerPromise) this.producerPromise = (async () => {
      const { Kafka } = await import('kafkajs');
      const producer = new Kafka({ clientId: this.clientId, brokers: this.brokers, ssl: this.ssl, sasl: this.sasl }).producer({ allowAutoTopicCreation: false, idempotent: true, maxInFlightRequests: 1 });
      await producer.connect();
      return producer;
    })();
    return this.producerPromise;
  }

  async publish(event) {
    try {
      const producer = await this.getProducer();
      await producer.send({ topic: this.topic, acks: -1, messages: [{ key: event.aggregateId, value: JSON.stringify(event), headers: { eventId: event.eventId, eventType: event.type, eventVersion: String(event.version), tenantId: event.tenantId } }] });
      return { accepted: true, broker: this.type, eventId: event.eventId };
    } catch {
      const failure = new Error('Kafka broker delivery failed.'); failure.code = 'KAFKA_BROKER_DELIVERY_FAILED'; throw failure;
    }
  }

  getHealth() { return { type: this.type, status: 'configured', durable: true, brokerCount: this.brokers.length, topic: this.topic }; }
}

export class RabbitMQBrokerAdapter extends DomainEventBroker {
  constructor({ url, exchange = 'healthcare-ai.domain-events', exchangeType = 'topic' } = {}) {
    super('rabbitmq');
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error('RabbitMQ broker requires a valid AMQP URL.'); }
    if (!['amqp:', 'amqps:'].includes(parsed.protocol)) throw new Error('RabbitMQ broker requires an amqp:// or amqps:// URL.');
    this.url = parsed.toString();
    this.exchange = String(exchange);
    this.exchangeType = String(exchangeType);
    this.channelPromise = null;
  }

  async getChannel() {
    if (!this.channelPromise) this.channelPromise = (async () => {
      const imported = await import('amqplib');
      const amqp = imported.default || imported;
      const connection = await amqp.connect(this.url);
      const channel = await connection.createConfirmChannel();
      await channel.assertExchange(this.exchange, this.exchangeType, { durable: true });
      return channel;
    })();
    return this.channelPromise;
  }

  async publish(event) {
    try {
      const channel = await this.getChannel();
      channel.publish(this.exchange, event.type, Buffer.from(JSON.stringify(event)), { persistent: true, contentType: 'application/json', messageId: event.eventId, correlationId: event.correlationId || event.eventId, timestamp: Date.now(), headers: { eventVersion: event.version, tenantId: event.tenantId } });
      await channel.waitForConfirms();
      return { accepted: true, broker: this.type, eventId: event.eventId };
    } catch {
      const failure = new Error('RabbitMQ broker delivery failed.'); failure.code = 'RABBITMQ_BROKER_DELIVERY_FAILED'; throw failure;
    }
  }

  getHealth() { return { type: this.type, status: 'configured', durable: true, endpointOrigin: new URL(this.url).host, exchange: this.exchange }; }
}

export function createDomainEventBroker({ type = 'projection', publisher, handler, webhook, kafka, rabbitmq } = {}) {
  const normalized = String(type).trim().toLowerCase();
  if (normalized === 'projection') return new ProjectionBrokerAdapter(handler);
  if (normalized === 'webhook') return new WebhookBrokerAdapter(webhook);
  if (normalized === 'kafka') return publisher ? new CallbackBrokerAdapter(normalized, publisher) : new KafkaBrokerAdapter(kafka);
  if (normalized === 'rabbitmq') return publisher ? new CallbackBrokerAdapter(normalized, publisher) : new RabbitMQBrokerAdapter(rabbitmq);
  throw new Error(`Unsupported domain event broker: ${normalized}`);
}
import { createHmac } from 'node:crypto';
