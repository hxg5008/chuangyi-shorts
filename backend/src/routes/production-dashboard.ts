import { Hono, type Context } from 'hono'
import { success } from '../utils/response.js'
import { productionDashboard, productionDashboardTask, productionDashboardDiagnostics } from '../services/production-dashboard.js'

const app = new Hono()
const integer = (value: string | undefined, fallback: number, maximum: number) => value && /^\d+$/u.test(value) && Number.isSafeInteger(Number(value)) ? Math.min(maximum, Number(value)) : fallback
function respond(c: Context, read: () => any) {
  try { return success(c, read()) }
  catch (error: any) {
    const status = [400, 401, 403, 404].includes(error?.status) ? error.status : 500
    return c.json({ code: status, message: status === 500 ? '运行看板暂时不可用' : status === 404 ? '记录不存在或无访问权限' : '当前请求无权访问或参数不正确' }, status)
  }
}
app.get('/', c => respond(c, () => productionDashboard({ projectId: integer(c.req.query('project_id'), 0, Number.MAX_SAFE_INTEGER) || undefined,
  limit: integer(c.req.query('limit'), 50, 100), offset: integer(c.req.query('offset'), 0, 1_000_000), exceptionsOnly: c.req.query('exceptions_only') === '1' })))
app.get('/tasks/:id', c => respond(c, () => ({ task: productionDashboardTask(c.req.param('id')) })))
app.get('/diagnostics/:id', c => respond(c, () => productionDashboardDiagnostics(c.req.param('id'))))
export default app
