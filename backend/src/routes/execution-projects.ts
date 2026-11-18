import { Hono } from 'hono'
import { success } from '../utils/response.js'
import { requireAdmin } from '../services/platform-security/index.js'
import { executionServiceAccounts, executionServiceSettings, saveExecutionService, projectExecutionStatus, adminProvisionProject, adminReauthorizeProject, executionAccountPolicies, saveExecutionAccountPolicies, projectExecutionOptions, selectProjectExecution, executionUserAccess, saveExecutionUserAccess, adminAdoptProjectCanvas, renameProjectCanvas } from '../services/execution-projects.js'

const admin = new Hono(), projects = new Hono()
const id = (value: string) => { if (!/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(Number(value))) throw Object.assign(new Error('编号格式错误。'), { status: 400 }); return Number(value) }
admin.use('*', async (c, next) => { requireAdmin(); c.header('Cache-Control','private, no-store'); await next() })
projects.use('*', async (c, next) => { c.header('Cache-Control','private, no-store'); await next() })
admin.get('/services/:id', c => success(c, executionServiceSettings(id(c.req.param('id')))))
admin.get('/services/:id/accounts', async c => success(c, await executionServiceAccounts(id(c.req.param('id')))))
admin.put('/services/:id', async c => success(c, await saveExecutionService(id(c.req.param('id')), await c.req.json())))
admin.get('/services/:id/account-policies', async c => success(c, await executionAccountPolicies(id(c.req.param('id')))))
admin.put('/services/:id/account-policies', async c => success(c, await saveExecutionAccountPolicies(id(c.req.param('id')), await c.req.json())))
admin.get('/services/:id/user-access',async c=>success(c,await executionUserAccess(id(c.req.param('id')))))
admin.put('/services/:id/user-access',async c=>success(c,await saveExecutionUserAccess(id(c.req.param('id')),await c.req.json())))
admin.post('/projects/:id/adopt-canvas',async c=>{
  const body=await c.req.json()
  if(!body||typeof body!=='object'||Array.isArray(body))throw Object.assign(Error('请提交画布与项目确认信息。'),{status:400})
  const {config_id,...input}=body
  return success(c,await adminAdoptProjectCanvas(id(String(config_id)),id(c.req.param('id')),input))
})
admin.post('/projects/:id/provision', async c => {
  const body = await c.req.json()
  if (Object.keys(body).some(key => !['config_id', 'canvas_id'].includes(key))) throw Object.assign(new Error('项目绑定只接受服务模型和可选画布编号。'), { status: 400 })
  return success(c, await adminProvisionProject(id(String(body.config_id)), id(c.req.param('id')), body.canvas_id))
})
projects.get('/:id/execution-route', c => success(c, projectExecutionStatus(id(c.req.param('id')))))
projects.get('/:id/execution-options', async c => success(c, await projectExecutionOptions(id(c.req.query('config_id') || ''), id(c.req.param('id')))))
projects.post('/:id/execution-route', async c => {
  const body = await c.req.json()
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('项目绑定需要 JSON 对象。'), {status:400})
  const {config_id,...selection}=body
  return success(c, await selectProjectExecution(id(String(config_id)), id(c.req.param('id')), selection))
})
projects.post('/:id/execution-canvas/rename',async c=>{
  const body=await c.req.json()
  if(!body||typeof body!=='object'||Array.isArray(body))throw Object.assign(Error('请提交画布改名信息。'),{status:400})
  const {config_id,...input}=body
  return success(c,await renameProjectCanvas(id(String(config_id)),id(c.req.param('id')),input))
})
admin.post('/projects/:id/reauthorize', async c => {
  const body = await c.req.json()
  if (Object.keys(body).some(key => !['config_id', 'confirmed'].includes(key)) || body.confirmed !== true) throw Object.assign(new Error('请明确确认重新授权原项目。'), { status: 400 })
  return success(c, await adminReauthorizeProject(id(String(body.config_id)), id(c.req.param('id'))))
})
export { admin as executionAdminRoutes, projects as executionProjectRoutes }
