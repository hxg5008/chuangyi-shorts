import fs from 'node:fs/promises'
import sharp from 'sharp'
import { fetchProvider } from './http.js'

export interface ImageDownloadProgress {
  receivedBytes: number
  totalBytes: number | null
  attempt: number
}

export interface ImageDownloadOptions {
  attempts?: number
  timeoutMs?: number
  idleTimeoutMs?: number
  totalTimeoutMs?: number
  retryDelayMs?: number
  maxBytes?: number
  onProgress?: (progress: ImageDownloadProgress) => void | Promise<void>
}

interface ResumeState {
  version: 1
  url: string
  responseUrl: string
  validator: { header: 'etag' | 'last-modified', value: string } | null
  totalBytes: number | null
  contentType: string | null
}

class DownloadError extends Error {
  constructor(message: string, readonly retryable = false, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ImageDownloadError'
  }
}

const configuredConcurrency = Number(process.env.HUOBAO_IMAGE_DOWNLOAD_CONCURRENCY)
const concurrency = Number.isInteger(configuredConcurrency) && configuredConcurrency >= 1 && configuredConcurrency <= 8
  ? configuredConcurrency : 2
let activeDownloads = 0
const waiters: Array<() => void> = []
const pendingPaths = new Map<string, Promise<void>>()

async function withDownloadSlot(action: () => Promise<void>): Promise<void> {
  if (activeDownloads < concurrency) activeDownloads++
  else await new Promise<void>(resolve => waiters.push(resolve))
  try { await action() }
  finally {
    const next = waiters.shift()
    if (next) next()
    else activeDownloads--
  }
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`${name} must be a positive integer`)
  return result
}

function contentLength(headers: Headers): number | null {
  const text = headers.get('content-length')
  if (text === null) return null
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) throw new DownloadError('Invalid image Content-Length')
  return Number(text)
}

function responseValidator(headers: Headers): ResumeState['validator'] {
  const etag = headers.get('etag')
  if (etag && /^"[^"\r\n]*"$/.test(etag)) return { header: 'etag', value: etag }
  const modified = headers.get('last-modified')
  if (modified && Number.isFinite(Date.parse(modified))) return { header: 'last-modified', value: modified }
  return null
}

async function removePartial(partialPath: string, metadataPath: string) {
  await Promise.all([
    fs.rm(partialPath, { force: true }),
    fs.rm(metadataPath, { force: true }),
    fs.rm(`${metadataPath}.tmp`, { force: true }),
  ])
}

async function loadPartial(partialPath: string, metadataPath: string, url: string, maxBytes: number) {
  try {
    const stat = await fs.stat(partialPath)
    const metadataStat = await fs.stat(metadataPath)
    if (!stat.isFile() || !metadataStat.isFile() || metadataStat.size > 16_384) throw new Error('Invalid partial')
    const state = JSON.parse(await fs.readFile(metadataPath, 'utf8')) as ResumeState
    const validator = state.validator
    if (state.version !== 1 || state.url !== url || typeof state.responseUrl !== 'string'
      || !validator || !['etag', 'last-modified'].includes(validator.header) || typeof validator.value !== 'string'
      || (validator.header === 'etag' ? !/^"[^"\r\n]*"$/.test(validator.value) : !Number.isFinite(Date.parse(validator.value)))
      || stat.size < 1 || stat.size > maxBytes
      || (state.totalBytes !== null && (!Number.isSafeInteger(state.totalBytes) || state.totalBytes < stat.size || state.totalBytes > maxBytes))) {
      throw new Error('Partial has no safe matching validator')
    }
    return { state, receivedBytes: stat.size }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code && !['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code!)) throw error
    await removePartial(partialPath, metadataPath)
    return null
  }
}

async function savePartialMetadata(metadataPath: string, state: ResumeState) {
  await fs.writeFile(`${metadataPath}.tmp`, JSON.stringify(state), 'utf8')
  await fs.rename(`${metadataPath}.tmp`, metadataPath)
}

async function validateImage(partialPath: string) {
  try {
    const image = sharp(partialPath, { limitInputPixels: 64_000_000, failOn: 'warning' })
    const metadata = await image.metadata()
    if (!metadata.width || !metadata.height || !['png', 'jpeg', 'webp', 'gif', 'heif', 'tiff', 'avif'].includes(metadata.format || '')) {
      throw new Error('Unsupported raster image')
    }
    // Decode the pixels as well as the header: a valid PNG/JPEG header alone is insufficient.
    await image.stats()
  } catch (error) {
    throw new DownloadError('Downloaded file is not a complete supported raster image', false, { cause: error })
  }
}

async function reportProgress(options: ImageDownloadOptions, progress: ImageDownloadProgress) {
  try { await options.onProgress?.(progress) }
  catch (error) { throw new DownloadError('Image download progress callback failed', false, { cause: error }) }
}

function retryable(error: unknown): boolean {
  if (error instanceof DownloadError) return error.retryable
  return error instanceof TypeError || ['TimeoutError', 'AbortError'].includes((error as Error)?.name)
}

async function download(url: string, filePath: string, options: ImageDownloadOptions, preservePartialOnFailure: boolean) {
  const attempts = positiveInteger(options.attempts, 3, 'Download attempts')
  if (attempts > 10) throw new Error('Download attempts must not exceed 10')
  const timeoutMs = positiveInteger(options.timeoutMs, 180_000, 'Download timeout')
  const idleTimeoutMs = positiveInteger(options.idleTimeoutMs, 30_000, 'Download idle timeout')
  const totalTimeoutMs = positiveInteger(options.totalTimeoutMs, 600_000, 'Download total timeout')
  const maxBytes = positiveInteger(options.maxBytes, 32 * 1024 * 1024, 'Download size limit')
  const retryDelayMs = options.retryDelayMs ?? 1_000
  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0) throw new Error('Download retry delay must be nonnegative')
  const partialPath = `${filePath}.part`
  const metadataPath = `${partialPath}.json`
  const deadline = Date.now() + totalTimeoutMs
  let completed = false
  let terminalError: unknown
  try {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      let resume = await loadPartial(partialPath, metadataPath, url, maxBytes)
      const controller = new AbortController()
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new DOMException('Image download total deadline exceeded', 'TimeoutError')
      const absoluteTimer = setTimeout(() => controller.abort(new DOMException('Image download attempt timed out', 'TimeoutError')), Math.min(timeoutMs, remaining))
      let idleTimer: ReturnType<typeof setTimeout> | undefined
      const armIdle = () => {
        clearTimeout(idleTimer)
        idleTimer = setTimeout(() => controller.abort(new DOMException('Image download made no progress', 'TimeoutError')), idleTimeoutMs)
      }
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      let handle: Awaited<ReturnType<typeof fs.open>> | undefined
      try {
        let receivedBytes = resume?.receivedBytes ?? 0
        await reportProgress(options, { receivedBytes, totalBytes: resume?.state.totalBytes ?? null, attempt })
        if (resume && resume.state.totalBytes === receivedBytes) {
          await validateImage(partialPath)
          controller.signal.throwIfAborted()
          await fs.rename(partialPath, filePath)
          completed = true
          return
        }
        const headers: Record<string, string> = { 'Accept-Encoding': 'identity' }
        if (resume) {
          headers.Range = `bytes=${receivedBytes}-`
          headers['If-Range'] = resume.state.validator!.value
        }
        armIdle()
        const response = await fetchProvider(url, { method: 'GET', headers, signal: controller.signal })
        reader = response.body?.getReader()
        if (!response.ok) {
          if (resume && [412, 416].includes(response.status)) {
            await removePartial(partialPath, metadataPath)
            throw new DownloadError(`Image download HTTP ${response.status}; restarting safely`, true)
          }
          throw new DownloadError(`Image download HTTP ${response.status}`, [408, 425, 429].includes(response.status) || response.status >= 500)
        }
        if (!reader) throw new DownloadError('Image download returned an empty body')
        armIdle()
        const encoded = ![null, 'identity'].includes(response.headers.get('content-encoding')?.toLowerCase() ?? null)
        const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() || null
        let totalBytes: number | null
        let responseBytes: number | null
        if (response.status === 206) {
          const range = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/i)
          const start = Number(range?.[1])
          const end = Number(range?.[2])
          const total = Number(range?.[3])
          const validator = resume?.state.validator
          const length = contentLength(response.headers)
          if (!resume || encoded || !range || ![start, end, total].every(Number.isSafeInteger)
            || start !== receivedBytes || end < start || end >= total
            || (length !== null && length !== end - start + 1)
            || (resume.state.totalBytes !== null && resume.state.totalBytes !== total)
            || response.url !== resume.state.responseUrl
            || !validator || response.headers.get(validator.header) !== validator.value
            || (resume.state.contentType && type && resume.state.contentType !== type)) {
            await removePartial(partialPath, metadataPath)
            throw new DownloadError('Unsafe image range response; restarting from the beginning', true)
          }
          totalBytes = total
          responseBytes = end - start + 1
        } else if (response.status === 200) {
          // A server may ignore Range or return a changed representation. Never append a 200.
          await removePartial(partialPath, metadataPath)
          resume = null
          receivedBytes = 0
          totalBytes = encoded ? null : contentLength(response.headers)
          responseBytes = totalBytes
        } else {
          throw new DownloadError(`Unexpected image download HTTP ${response.status}`)
        }
        if (totalBytes !== null && totalBytes > maxBytes) throw new DownloadError('Image download exceeds the size limit')
        if (type?.startsWith('text/') || ['application/json', 'image/svg+xml'].includes(type || '')) {
          throw new DownloadError('Image download returned a non-raster response')
        }
        const state: ResumeState = {
          version: 1, url, responseUrl: response.url,
          validator: encoded ? null : (resume?.state.validator ?? responseValidator(response.headers)),
          totalBytes, contentType: type,
        }
        await savePartialMetadata(metadataPath, state)
        handle = await fs.open(partialPath, resume ? 'a' : 'w')
        await reportProgress(options, { receivedBytes, totalBytes, attempt })
        let currentResponseBytes = 0
        for (;;) {
          controller.signal.throwIfAborted()
          const { done, value } = await reader.read()
          if (done) break
          armIdle()
          if (receivedBytes + value.byteLength > maxBytes) throw new DownloadError('Image download exceeds the size limit')
          if (totalBytes !== null && receivedBytes + value.byteLength > totalBytes) throw new DownloadError('Image download exceeds its declared length')
          if (responseBytes !== null && currentResponseBytes + value.byteLength > responseBytes) throw new DownloadError('Image download exceeds its declared range')
          let offset = 0
          while (offset < value.byteLength) {
            const written = await handle.write(value, offset, value.byteLength - offset)
            if (!written.bytesWritten) throw new DownloadError('Unable to write image download')
            offset += written.bytesWritten
          }
          receivedBytes += value.byteLength
          currentResponseBytes += value.byteLength
          await reportProgress(options, { receivedBytes, totalBytes, attempt })
        }
        controller.signal.throwIfAborted()
        await handle.close()
        handle = undefined
        if (!receivedBytes) throw new DownloadError('Image download returned an empty file')
        if ((responseBytes !== null && currentResponseBytes !== responseBytes) || (totalBytes !== null && receivedBytes !== totalBytes)) {
          throw new DownloadError('Image download ended before all bytes arrived', true)
        }
        await validateImage(partialPath)
        controller.signal.throwIfAborted()
        await fs.rename(partialPath, filePath)
        completed = true
        return
      } catch (error) {
        if (!retryable(error) || attempt === attempts || Date.now() >= deadline) throw error
      } finally {
        clearTimeout(absoluteTimer)
        clearTimeout(idleTimer)
        await reader?.cancel().catch(() => {})
        reader?.releaseLock()
        await handle?.close()
      }
      const delay = Math.min(retryDelayMs * 2 ** (attempt - 1), 10_000, Math.max(0, deadline - Date.now()))
      if (delay) await new Promise(resolve => setTimeout(resolve, delay))
    }
  } catch (error) {
    terminalError = error
    throw error
  } finally {
    if (completed) {
      await fs.rm(metadataPath, { force: true })
      await fs.rm(`${metadataPath}.tmp`, { force: true })
    } else {
      // A stable task key can reuse a validated partial after a bounded network failure.
      // All handles are closed above before its size and validator are checked again.
      let keepPartial = false
      if (preservePartialOnFailure && retryable(terminalError)) {
        try { keepPartial = (await loadPartial(partialPath, metadataPath, url, maxBytes)) !== null } catch {}
      }
      if (!keepPartial) await removePartial(partialPath, metadataPath)
    }
  }
}

/** Stream, validate and atomically publish an image. Slots cover network retries and decoding. */
export function downloadImageToFile(url: string, filePath: string, options: ImageDownloadOptions = {}, preservePartialOnFailure = false): Promise<void> {
  const previous = pendingPaths.get(filePath) ?? Promise.resolve()
  const pending = previous.catch(() => {}).then(() => withDownloadSlot(() => download(url, filePath, options, preservePartialOnFailure)))
  pendingPaths.set(filePath, pending)
  void pending.finally(() => { if (pendingPaths.get(filePath) === pending) pendingPaths.delete(filePath) }).catch(() => {})
  return pending
}
