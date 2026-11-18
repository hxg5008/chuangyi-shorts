import { getActiveConfig, getConfigById, assertConfiguredModel } from './ai.js'
import { assertMediaAccess, registerPrivateMedia } from './platform-security/media.js'
import { ASSET_REFERENCE_MAX_BYTES, ASSET_REFERENCE_TOTAL_BYTES, assetImageError, canonicalAssetImage, decodeAssetImage, readAssetImage, freezeAssetReference } from './asset-image-files.js'
import { validateChannelControls } from './channel-controls.js'

/** Manual redraw is an explicit transport operation, not a prompt-writing step. */
export async function prepareAssetRedraw(body: any, asset: { dramaId: number; deletedAt?: string | null }, episode: { dramaId: number; imageConfigId?: number | null }) {
  if (asset.deletedAt) throw assetImageError('素材已删除，未提交图片生成。', 404)
  if (asset.dramaId !== episode.dramaId) throw assetImageError('素材与当前剧集不属于同一项目。', 403)
  if (body.manual !== true) throw assetImageError('手动重绘标记不正确。')
  if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 100000) throw assetImageError('请填写有效的最终提示词（不超过100000字符）。')
  const selected = body.config_id ?? episode.imageConfigId
  if (selected != null && (!Number.isSafeInteger(Number(selected)) || Number(selected) <= 0)) throw assetImageError('图片服务配置编号不正确。')
  const config = selected != null ? await getConfigById(Number(selected)) : await getActiveConfig('image')
  if (!config || config.serviceType && config.serviceType !== 'image') throw assetImageError('所选图片服务不可用，请重新选择；未切换其他服务。')
  const model = assertConfiguredModel(config, body.model)
  if (typeof model !== 'string' || !model.trim() || model.length > 200 || /[\x00-\x1f]/u.test(model)) throw assetImageError('请选择有效的图片型号。')
  const raw = body.reference_images ?? []
  if (!Array.isArray(raw) || raw.some(ref => typeof ref !== 'string' || !ref.trim())) throw assetImageError('参考图必须为上传图片路径列表。')
  const caps = config.capabilities || {}, declared = [caps.max_images, caps.max_reference_images, caps.maxReferenceImages].filter(value => Number.isFinite(value) && value >= 0)
  const official = model === 'imagegen' || config.protocolId === 'image.codex-official'
  const limit = Math.min(official ? 5 : 6, ...declared)
  if (raw.length > limit) throw assetImageError(`参考图数量超过所选模型上限（${limit}张），不会自动截断。`)
  if (raw.length && [caps.reference_images, caps.supports_reference_images, caps.image_input].includes(false)) throw assetImageError('所选图片模型不支持参考图，未提交生成。')
  if (raw.length && (config.provider === 'volcengine' || config.provider === 'gemini' && /generativelanguage\.googleapis\.com/iu.test(config.baseUrl) && /gemini-3.*image/u.test(model))) throw assetImageError('当前图片接口分支尚不支持传输参考图，请切换支持参考图的接口；未改成纯文生图。')
  validateChannelControls(config, { referenceImages: raw })
  const frozen: string[] = [], hashes: string[] = []
  let bytes = 0
  for (const reference of raw) {
    try {
    assertMediaAccess(reference)
    let image
    if (canonicalAssetImage(reference)) image = await readAssetImage(reference, undefined, ASSET_REFERENCE_MAX_BYTES)
    else {
      const inline = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]*={0,2})$/u.exec(reference)
      if (!inline) throw assetImageError('请上传参考图片，不接受远程网址或本机文件路径。')
      image = await decodeAssetImage(Buffer.from(inline[1], 'base64'))
    }
    bytes += image.size
    if (bytes > ASSET_REFERENCE_TOTAL_BYTES) throw assetImageError('本次参考图总大小不能超过35MB。')
    const snapshot = await freezeAssetReference(image, asset.dramaId)
    registerPrivateMedia(snapshot, asset.dramaId)
    frozen.push(snapshot); hashes.push(image.sha256)
    } catch (error: any) {
      if (error.status) throw error
      throw assetImageError('参考图读取或快照保存失败，请重新上传后再试。')
    }
  }
  const fresh = config.id ? await getConfigById(config.id) : null
  if (!fresh || fresh.provider !== config.provider || fresh.baseUrl !== config.baseUrl || fresh.apiKey !== config.apiKey || fresh.protocolId !== config.protocolId) throw assetImageError('图片服务配置已变化，请重新选择后生成。', 409)
  return { prompt: body.prompt as string, configId: config.id, model, referenceImages: frozen, referenceImageHashes: hashes, referenceImageSources: raw.map(reference => canonicalAssetImage(reference) || '[inline-image]') }
}
