import { relayOrigin } from '../public/broadcast.js';

export class RelaySession {
  #fetch;
  #credentials;
  #busy = false;
  constructor(request = fetch) { this.#fetch = request; }
  get active() { return Boolean(this.#credentials); }

  async #request(method, credentials) {
    const response = await this.#fetch(`${credentials.origin}/api/session`, {
      method, headers: { Authorization: `Bearer ${credentials.key}` },
      redirect: 'error', signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw Object.assign(new Error(`Server request failed (${response.status}). Check the server address and publisher key, then retry.`), { status: response.status });
    return response.status === 204 ? {} : response.json();
  }

  async create(url, key) {
    if (this.active || this.#busy) throw new Error('End the current Internet session before creating another.');
    const origin = relayOrigin(url);
    if (typeof key !== 'string' || !key.trim() || key.length > 512 || /[\r\n]/.test(key)) throw new Error('Enter the publisher key from your server.');
    this.#busy = true;
    const credentials = { origin, key: key.trim() };
    // Keep the revocation capability even if a response is lost after the server created a room.
    this.#credentials = credentials;
    try { return await this.#request('POST', credentials); }
    catch (error) {
      if (error.status >= 400 && error.status < 500) this.#credentials = null;
      throw error;
    }
    finally { this.#busy = false; }
  }

  async end() {
    if (this.#busy) throw new Error('A server request is still in progress. Try again in a moment.');
    if (!this.#credentials) return;
    this.#busy = true;
    try {
      await this.#request('DELETE', this.#credentials);
      this.#credentials = null;
    } finally { this.#busy = false; }
  }
}
