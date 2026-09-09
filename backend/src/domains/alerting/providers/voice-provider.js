export class VoiceProvider {
  constructor(configuration) {
    this.configuration = structuredClone(configuration);
  }

  placeCall() {
    throw new Error('VOICE_PROVIDER_NOT_IMPLEMENTED');
  }

  cancelCall() {
    throw new Error('VOICE_PROVIDER_NOT_IMPLEMENTED');
  }

  verifyCallback() {
    return false;
  }
}
