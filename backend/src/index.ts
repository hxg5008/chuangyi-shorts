import 'dotenv/config'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { bodyLimit } from 'hono/body-limit'
import path from 'path'
import { fileURLToPath } from 'url'

import dramas from './routes/dramas.js'
import documentImports from './routes/document-import.js'
import episodes from './routes/episodes.js'
import storyboards from './routes/storyboards.js'
import scenes from './routes/scenes.js'
import characters from './routes/characters.js'
import tasks from './routes/tasks.js'
import upload from './routes/upload.js'
import aiConfigs, { aiProviders } from './routes/aiConfigs.js'
import stylePresets from './routes/stylePresets.js'
import prompts from './routes/prompts.js'
import agent from './routes/agent.js'
import merge from './routes/merge.js'
import skills from './routes/skills.js'
import props from './routes/props.js'
import settings from './routes/settings.js'
import storage from './routes/storage.js'
import serverUpdate from './routes/serverUpdate.js'
import { requestLogger, errorHandler, httpErrorHandler } from './middleware/logger.js'
import { resumeInterruptedTasks, startJimengAutoReturnSweep } from './services/generation.js'
import { DATA_ROOT } from './utils/paths.js'
import platformAuth from './routes/platform-auth.js'
import platformUsers from './routes/platform-users.js'
import { initPlatformSecurity, platformSecurityMiddleware, privateMediaMiddleware } from './services/platform-security/index.js'
import { modelChannelAdminRoutes, modelCatalogRoutes } from './routes/model-channels.js'
import activity from './routes/activity.js'
import requestLogs from './routes/request-logs.js'
import { installRequestLogging } from './services/request-logs/capture.js'
import { db } from './db/index.js'
import { activityRequestContext } from './services/activity/context.js'
import { recoverActivityJournal } from './services/activity/source-sync.js'
import { installActivityLogger } from './services/activity/logger.js'
import modelTests from './routes/model-tests.js'
import { initializeProviderCatalog } from './services/model-channels/plugin-catalog.js'
import assetImageJobs from './routes/asset-image-jobs.js'
import assetImages from './routes/asset-images.js'
import { recoverAssetImagePreparationJobs } from './services/asset-image-preparation.js'
import productionBatches from './routes/production-batches.js'
import productionDashboard from './routes/production-dashboard.js'
import { recoverProductionBatches, startProductionBatchScheduler } from './services/production-batches.js'
import { PLATFORM_RELEASE } from './utils/platform-release.js'
import { executionAdminRoutes, executionProjectRoutes } from './routes/execution-projects.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '../..')

const app = new Hono()
app.onError(httpErrorHandler)
initPlatformSecurity()
recoverActivityJournal()
recoverAssetImagePreparationJobs()
recoverProductionBatches()
installActivityLogger()
installRequestLogging(db.$client)
await initializeProviderCatalog()

// Middleware
app.use('*', cors({
  origin: ['http://localhost:3013', 'http://localhost:5679'],
  credentials: true,
}))
app.use('*', errorHandler)
app.use('/api/*', async (c, next) => {
  if (['GET','HEAD','OPTIONS'].includes(c.req.method)) return next()
  const limit = /\/upload\/video$/u.test(c.req.path) ? 51 : /\/upload\/image$/u.test(c.req.path) ? 31
    : /\/upload\/audio$|\/characters\/\d+\/voice$/u.test(c.req.path) ? 21 : /\/admin\/protocols\/import$/u.test(c.req.path) ? 33 : 10
  return bodyLimit({ maxSize: limit * 1024 * 1024, onError: ctx => ctx.json({ code: 413, message: `请求内容超过${limit}MB，请减少本次上传或批量内容` }, 413) })(c, next)
})
app.use('/api/*', platformSecurityMiddleware)
app.use('*', requestLogger)
app.use('/api/*', activityRequestContext)
app.use('/static/*', privateMediaMiddleware)

// Health check（version 供部署巡检/更新检查核对当前运行版本）
app.get('/api/v1/health', (c) => c.json({
  status: 'ok',
  version: process.env.HUOBAO_VERSION || undefined,
  release: PLATFORM_RELEASE,
  processId: process.pid,
  timestamp: new Date().toISOString(),
}))

// API routes
const api = new Hono()
api.route('/auth', platformAuth)
api.route('/admin/users', platformUsers)
api.route('/admin', modelChannelAdminRoutes)
api.route('/admin/model-tests', modelTests)
api.route('/admin/execution', executionAdminRoutes)
api.route('/dramas', executionProjectRoutes)
api.route('/models', modelCatalogRoutes)
api.route('/activity', activity)
api.route('/admin/requests', requestLogs)
api.route('/asset-image-jobs', assetImageJobs)
api.route('/asset-images', assetImages)
api.route('/production-batches', productionBatches)
api.route('/production-dashboard', productionDashboard)
api.route('/dramas', dramas)
api.route('/dramas', documentImports)
api.route('/episodes', episodes)
api.route('/storyboards', storyboards)
api.route('/scenes', scenes)
api.route('/characters', characters)
api.route('/tasks', tasks)
api.route('/upload', upload)
api.route('/ai-configs', aiConfigs)
api.route('/ai-providers', aiProviders)
api.route('/style-presets', stylePresets)
api.route('/prompts', prompts)
api.route('/agent', agent)
api.route('/merge', merge)
api.route('/skills', skills)
api.route('/props', props)
api.route('/storage', storage)
api.route('/settings', settings)
api.route('/server-update', serverUpdate)

app.route('/api/v1', api)

// Serve static files (storage)
// 生成的图片/视频按 uuid 命名、内容不变，标记为 immutable 让浏览器长缓存
app.use('/static/*', async (c, next) => {
  // Download fragments and their signed-URL metadata are private implementation state.
  if (/\.(?:part(?:\.json)?(?:\.tmp)?|tmp)$/i.test(c.req.path)) return c.notFound()
  await next()
  if (c.res.ok) c.header('Cache-Control', 'private, no-store')
})
app.use('/static/*', serveStatic({ root: DATA_ROOT }))

// Serve frontend (production build) — 桌面版由主进程注入 FRONTEND_DIST（resources/frontend）
const distPath = process.env.FRONTEND_DIST || path.join(projectRoot, 'frontend', 'dist')
app.use('*', serveStatic({ root: distPath }))
app.get('*', serveStatic({ root: distPath, path: 'index.html' }))

const port = Number(process.env.PORT || 5679)
// 未设置 HOST 时保留默认监听行为，兼容 Docker 端口映射；本机部署设为 127.0.0.1。
const hostname = process.env.HOST || undefined

await resumeInterruptedTasks()
await startProductionBatchScheduler()
// Round 5: bring finished Jimeng videos back automatically (every 10 minutes by default).
startJimengAutoReturnSweep()

serve({ fetch: app.fetch, port, hostname }, (info) => {
  const host = info.address.includes(':') ? `[${info.address}]` : info.address
  console.log(`🚀 创一剧坊 Chuangyi server on http://${host}:${info.port}`)
})
