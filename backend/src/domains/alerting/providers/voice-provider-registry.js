import { MockVoiceProvider } from './mock-voice-provider.js';

export function createVoiceProvider(configuration) {
  if (!configuration?.enabled) return null;
  if (configuration.type === 'mock') return new MockVoiceProvider(configuration);
  return null;
}
