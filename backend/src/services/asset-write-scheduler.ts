import { AsyncResource } from 'node:async_hooks'

export type AssetWriteCategory = 'characters' | 'scenes' | 'props'
const categories: Record<string, AssetWriteCategory> = {
  save_dedup_characters: 'characters',
  save_voice_cards: 'characters',
  save_character_final_prompt: 'characters',
  save_dedup_scenes: 'scenes',
  save_scene_final_prompt: 'scenes',
  save_dedup_props: 'props',
  save_prop_final_prompt: 'props'
}
export const assetWriteCategory = (toolId: string): AssetWriteCategory | undefined =>
  Object.hasOwn(categories, toolId) ? categories[toolId] : undefined
interface Entry {
  run: () => unknown
  resolve: (value: any) => void
  reject: (error: unknown) => void
  started: boolean
  signal?: AbortSignal
  abort?: () => void
}
interface Lane {
  active: boolean
  pending: Entry[]
}

/** Serialize only short writes to the same project/category; model/network work never enters this queue. */
export class AssetWriteScheduler {
  private readonly lanes = new Map<string, Lane>()
  run<T>(
    projectId: number,
    category: AssetWriteCategory,
    write: () => T | Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    if (
      !Number.isSafeInteger(projectId) ||
      projectId < 1 ||
      !['characters', 'scenes', 'props'].includes(category)
    )
      return Promise.reject(new Error('资产写入调度缺少项目或类别'))
    if (signal?.aborted) return Promise.reject(signal.reason)
    const key = `${projectId}/${category}`,
      lane = this.lanes.get(key) || { active: false, pending: [] }
    this.lanes.set(key, lane)
    // A released lane may run under another request's context; bind each writer to its own caller.
    const run = AsyncResource.bind(write)
    return new Promise<T>((resolve, reject) => {
      const entry: Entry = { run, resolve, reject, started: false, signal }
      entry.abort = () => {
        if (entry.started) return
        const index = lane.pending.indexOf(entry)
        if (index < 0) return
        lane.pending.splice(index, 1)
        signal?.removeEventListener('abort', entry.abort!)
        reject(signal?.reason)
        if (!lane.active && !lane.pending.length && this.lanes.get(key) === lane) this.lanes.delete(key)
      }
      lane.pending.push(entry)
      signal?.addEventListener('abort', entry.abort, { once: true })
      if (signal?.aborted) entry.abort()
      this.drain(key, lane)
    })
  }
  private drain(key: string, lane: Lane) {
    if (lane.active) return
    const entry = lane.pending.shift()
    if (!entry) {
      if (this.lanes.get(key) === lane) this.lanes.delete(key)
      return
    }
    if (entry.signal?.aborted) {
      entry.signal.removeEventListener('abort', entry.abort!)
      entry.reject(entry.signal.reason)
      this.drain(key, lane)
      return
    }
    lane.active = true
    entry.started = true
    void Promise.resolve()
      .then(entry.run)
      .then(entry.resolve, entry.reject)
      .finally(() => {
        entry.signal?.removeEventListener('abort', entry.abort!)
        lane.active = false
        this.drain(key, lane)
      })
  }
}
export const assetWriteScheduler = new AssetWriteScheduler()
