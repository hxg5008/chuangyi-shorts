import { AsyncLocalStorage } from 'node:async_hooks'

/** Diagnostic correlation only; never part of a provider payload. */
export interface RequestLogContext {
  taskId?: string; roundId?: string; parentId?: string; actorUserId?: number | null
  projectOwnerId?: number | null; projectId?: number | null; episodeId?: number | null
  configId?: number | null; channelId?: number | null; channelName?: string | null
  model?: string | null; kind?: 'text'|'image'|'video'|'unknown'
  phase?: 'generate'|'poll'|'upload'|'download'|'other'; upstreamTaskId?: string | null
}
const storage = new AsyncLocalStorage<RequestLogContext>()
export const currentRequestLogContext = () => storage.getStore() || null
export const withRequestLogContext = <T>(value: RequestLogContext, action: () => T): T =>
  storage.run({ ...storage.getStore(), ...value }, action)
