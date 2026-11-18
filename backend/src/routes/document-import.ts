import { Hono } from 'hono'
import { success } from '../utils/response.js'
import { previewDocumentImport, commitDocumentImport, listDocumentImports, getDocumentImportSource } from '../services/document-import.js'
import { getActiveConfigId, getConfigById, assertConfigService } from '../services/ai.js'
import { requireActor, assertProjectAccess } from '../services/platform-security/index.js'

const app = new Hono()
// Mounted beneath /dramas so the existing user/project middleware covers every import action.
app.post('/:id/imports/preview', async c => {
  const actor = requireActor(), projectId = Number(c.req.param('id'))
  assertProjectAccess(projectId, actor)
  const preview = previewDocumentImport(projectId, await c.req.json(), actor)
  return success(c, { ...preview, model_defaults: { image_config_id: await getActiveConfigId('image'), video_config_id: await getActiveConfigId('video') } })
})
app.post('/:id/imports/:importId/commit', async c => {
  const actor = requireActor(), projectId = Number(c.req.param('id'))
  assertProjectAccess(projectId, actor)
  const body = await c.req.json()
  // Import can precede model configuration. When configured, lock exactly the same authorized models as normal creation.
  for (const [field, kind] of [['image_config_id', 'image'], ['video_config_id', 'video']] as const) {
    const id = body[field]
    if (id != null) { const config = await getConfigById(Number(id)); if (!config) throw Object.assign(new Error('所选模型已停用、删除或未获授权。'), { status: 400 }); assertConfigService(config, kind); body[field] = Number(id) }
  }
  if (body.video_config_id) {
    const config = await getConfigById(Number(body.video_config_id))
    const choices = config?.capabilities?.resolutions ?? config?.parameters?.find(p => p.key === 'resolution' || p.binding === 'resolution')?.options
    if (Array.isArray(choices) && choices.length) {
      const values = choices.map(choice => typeof choice === 'object' && choice !== null ? choice.value : choice)
      body.resolution ??= values.includes(config?.defaults?.resolution) ? config?.defaults?.resolution : values.includes('720p') ? '720p' : values[0]
      if (!values.includes(body.resolution)) throw Object.assign(new Error('分辨率不在所选视频模型的选项中。'), { status: 400 })
    }
  }
  return success(c, commitDocumentImport(projectId, c.req.param('importId'), body, actor))
})
app.get('/:id/imports', c => success(c, listDocumentImports(Number(c.req.param('id')))))
app.get('/:id/imports/:importId/source', c => {
  const source = getDocumentImportSource(Number(c.req.param('id')), c.req.param('importId'))
  c.header('Content-Type', 'application/octet-stream')
  c.header('Content-Disposition', `attachment; filename="source.txt"; filename*=UTF-8''${encodeURIComponent(source.filename)}`)
  c.header('Cache-Control', 'private, no-store')
  c.header('X-Content-Type-Options', 'nosniff')
  return c.body(new Uint8Array(source.bytes))
})
export default app
