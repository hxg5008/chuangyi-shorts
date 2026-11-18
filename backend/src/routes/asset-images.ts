import { Hono, type Context } from 'hono'
import { success } from '../utils/response.js'
import { getAssetImageHistoryService } from '../services/asset-image-history.js'
import { assertResourceAccess, requireActor } from '../services/platform-security/access.js'
import { assetImageError } from '../services/asset-image-files.js'

const app = new Hono()
app.use('*', async (c, next) => {
  c.header('Cache-Control', 'private, no-store')
  await next()
})
function authorize(c: Context) {
  const kind = c.req.param('type'), raw = c.req.param('id')
  if (!['character', 'scene', 'prop'].includes(kind || '') || !/^[1-9]\d*$/u.test(raw || '') || !Number.isSafeInteger(Number(raw))) throw assetImageError('素材类型或编号无效。')
  assertResourceAccess(kind as 'character' | 'scene' | 'prop', Number(raw), undefined, requireActor())
  return { kind: kind!, id: Number(raw) }
}
app.onError((error: any, c) => {
  const status = [400, 401, 403, 404, 409, 413].includes(error.statusCode || error.status) ? error.statusCode || error.status : 500
  return c.json({ code: status, message: status === 500 ? '图片历史暂不可用，请稍后重试。' : error.message }, status)
})
app.get('/:type/:id', async c => { const {kind,id}=authorize(c); return success(c, await (await getAssetImageHistoryService()).list(kind,id,Number(c.req.query('limit')) || 200,c.req.query('before_id') ? Number(c.req.query('before_id')) : undefined)) })
app.get('/:type/:id/:versionId', async c => { const {kind,id}=authorize(c); return success(c, await (await getAssetImageHistoryService()).detail(kind,id,Number(c.req.param('versionId')))) })
app.post('/:type/:id/:versionId/adopt', async c => { const {kind,id}=authorize(c); return success(c, await (await getAssetImageHistoryService()).adopt(kind,id,Number(c.req.param('versionId')))) })
app.delete('/:type/:id/:versionId', async c => { const {kind,id}=authorize(c); return success(c, await (await getAssetImageHistoryService()).remove(kind,id,Number(c.req.param('versionId')))) })
export default app
