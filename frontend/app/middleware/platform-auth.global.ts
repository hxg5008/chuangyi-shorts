import { loadPlatformSession, safeNextPath } from '~/utils/platform-session'

export default defineNuxtRouteMiddleware(async to => {
  try {
    const user = await loadPlatformSession()
    if (to.path === '/login' || to.path === '/register') {
      if (user) return navigateTo(safeNextPath(to.query.next), { replace: true })
      return
    }
    if (!user) return navigateTo('/login?next=' + encodeURIComponent(to.fullPath), { replace: true })
    if ((to.path === '/settings' || to.path.startsWith('/admin')) && user.role !== 'admin') return navigateTo('/', { replace: true })
  } catch {
    if (to.path !== '/login' && to.path !== '/register') return navigateTo('/login?connection=unavailable', { replace: true })
  }
})
