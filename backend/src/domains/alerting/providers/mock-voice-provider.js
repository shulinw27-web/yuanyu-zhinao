import { randomUUID } from 'node:crypto';
import { VoiceProvider } from './voice-provider.js';

export class MockVoiceProvider extends VoiceProvider {
  placeCall(request) {
    return {
      providerCallId: `mock-call-${randomUUID()}`,
      status: 'answered',
      startedAt: new Date().toISOString(),
      answeredAt: new Date().toISOString(),
      playbackStatus: 'played',
      supportsDtmf: true,
      requestFingerprint: request.idempotencyKey
    };
  }

  cancelCall(providerCallId) {
    return { providerCallId, status: 'cancelled', cancelledAt: new Date().toISOString() };
  }

  verifyCallback(headers = {}) {
    return headers['x-mock-provider'] === 'authenticated-test-adapter';
  }
}
