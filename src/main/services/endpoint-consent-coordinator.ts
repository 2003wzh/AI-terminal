import {
  ConsentStore,
  normalizeEndpoint,
  type EndpointConsentGrant
} from '../security/consent-store.ts'

export type EndpointConsentPrompt = (endpoint: string) => Promise<boolean>

export class EndpointConsentCoordinatorError extends Error {
  readonly code: 'denied' | 'prompt_failed' | 'disposed'

  constructor(code: 'denied' | 'prompt_failed' | 'disposed') {
    super(
      code === 'denied'
        ? 'Endpoint access was not approved.'
        : code === 'disposed'
          ? 'Endpoint approval is no longer available.'
          : 'Endpoint approval could not be requested.'
    )
    this.name = 'EndpointConsentCoordinatorError'
    this.code = code
    this.stack = `${this.name}: ${this.message}`
  }
}

export class EndpointConsentCoordinator {
  readonly #store: ConsentStore
  readonly #prompt: EndpointConsentPrompt
  readonly #confirmedHandles = new Map<string, string>()
  readonly #pending = new Map<string, Promise<EndpointConsentGrant>>()
  #disposed = false

  constructor(store: ConsentStore, prompt: EndpointConsentPrompt) {
    this.#store = store
    this.#prompt = prompt
  }

  async ensure(rawEndpoint: unknown): Promise<EndpointConsentGrant> {
    if (this.#disposed) throw new EndpointConsentCoordinatorError('disposed')
    const endpoint = normalizeEndpoint(rawEndpoint)
    const existingHandle = this.#confirmedHandles.get(endpoint)
    if (existingHandle) {
      const authorized = this.#store.authorizeEndpoint({
        consentHandle: existingHandle,
        endpoint
      })
      if (authorized) return { consentHandle: existingHandle, endpoint: authorized }
      this.#confirmedHandles.delete(endpoint)
    }

    const existingRequest = this.#pending.get(endpoint)
    if (existingRequest) return existingRequest

    const request = this.#request(endpoint)
    this.#pending.set(endpoint, request)
    try {
      return await request
    } finally {
      if (this.#pending.get(endpoint) === request) this.#pending.delete(endpoint)
    }
  }

  clear(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#confirmedHandles.clear()
    this.#pending.clear()
    this.#store.clear()
  }

  async #request(endpoint: string): Promise<EndpointConsentGrant> {
    let approved: boolean
    try {
      approved = await this.#prompt(endpoint)
    } catch {
      if (this.#disposed) throw new EndpointConsentCoordinatorError('disposed')
      throw new EndpointConsentCoordinatorError('prompt_failed')
    }
    if (this.#disposed) throw new EndpointConsentCoordinatorError('disposed')
    if (!approved) throw new EndpointConsentCoordinatorError('denied')

    const grant = this.#store.confirmEndpoint(endpoint)
    this.#confirmedHandles.set(grant.endpoint, grant.consentHandle)
    return grant
  }
}
