import { join } from 'node:path'

import { ConsentStore } from '../security/consent-store'
import { SecureStore, createElectronSafeStorageCipher } from '../security/secure-store'
import { AccessProfileService, type AccessProfileStorage } from './access-profile-service'
import {
  ConversationHistoryService,
  type ConversationHistoryStorage
} from './conversation-history-service'
import { RemoteModelCatalogService } from './model-catalog'
import {
  SecureRelayCredentialStorage,
  type RelayCredentialStringStore
} from './relay-credential-storage'
import {
  RelayService,
  type RelayEncryptedCredentialStorage,
  type RelayStoredCredential
} from './relay-service'
import { OpenAICompatibleResponsesClient } from './responses-client'
import { CapabilityRegistry } from './capability-registry'

export interface MainBackendServices {
  profiles: AccessProfileService
  conversations: ConversationHistoryService
  consents: ConsentStore
  modelCatalog: RemoteModelCatalogService
  responses: OpenAICompatibleResponsesClient
  relay: RelayService
  capabilities: CapabilityRegistry
}

export interface MainBackendServiceOptions {
  relayServerOrigin?: string
}

export async function createMainBackendServices(
  userDataPath: string,
  options: MainBackendServiceOptions = {}
): Promise<MainBackendServices> {
  let profileStorage: AccessProfileStorage
  let conversationStorage: ConversationHistoryStorage
  let relayCredentialStorage: RelayEncryptedCredentialStorage
  try {
    const cipher = await createElectronSafeStorageCipher()
    profileStorage = new SecureStore({
      filePath: join(userDataPath, 'secure', 'access-profiles.json'),
      purpose: 'access-profiles',
      cipher
    })
    conversationStorage = new SecureStore({
      filePath: join(userDataPath, 'secure', 'conversation-history.json'),
      purpose: 'conversation-history',
      cipher
    })
    const relayStringStore: RelayCredentialStringStore = new SecureStore({
      filePath: join(userDataPath, 'secure', 'relay-device-credential.json'),
      purpose: 'relay-device-credential',
      cipher
    })
    relayCredentialStorage = new SecureRelayCredentialStorage(relayStringStore)
  } catch {
    // Keep the application usable for actionable diagnostics, but never fall
    // back to plaintext or release an existing credential when DPAPI is unavailable.
    profileStorage = failClosedStorage()
    conversationStorage = failClosedStorage()
    relayCredentialStorage = failClosedStorage()
  }

  return {
    profiles: new AccessProfileService(profileStorage),
    conversations: new ConversationHistoryService(conversationStorage),
    consents: new ConsentStore(),
    modelCatalog: new RemoteModelCatalogService(),
    responses: new OpenAICompatibleResponsesClient(),
    capabilities: new CapabilityRegistry(),
    relay: new RelayService({
      credentialStorage: relayCredentialStorage,
      ...(options.relayServerOrigin === undefined
        ? {}
        : { serverOrigin: options.relayServerOrigin })
    })
  }
}

function failClosedStorage(): AccessProfileStorage &
  ConversationHistoryStorage &
  RelayEncryptedCredentialStorage {
  return {
    async read(): Promise<never> {
      throw new Error('Secure profile storage is unavailable.')
    },
    async write(): Promise<never> {
      throw new Error('Secure profile storage is unavailable.')
    },
    async loadCredential(): Promise<never> {
      throw new Error('Secure relay credential storage is unavailable.')
    },
    async saveCredential(_credential: RelayStoredCredential): Promise<never> {
      throw new Error('Secure relay credential storage is unavailable.')
    },
    async clearCredential(): Promise<never> {
      throw new Error('Secure relay credential storage is unavailable.')
    }
  }
}
