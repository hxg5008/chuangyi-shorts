/** Legacy settings bookmarks keep working without exposing duplicate editors. */
const destinations = Object.freeze({
  ai: '/admin/channels', models: '/admin/channels', services: '/admin/channels',
  general: '/admin/preferences', preferences: '/admin/preferences',
  styles: '/admin/styles', style: '/admin/styles',
  agents: '/admin/workflow', skills: '/admin/workflow', workflow: '/admin/workflow',
  storage: '/admin/storage',
})

export function legacySettingsDestination(query = {}, hash = '') {
  const candidates = [query.tab, query.section]
  const fragment = typeof hash === 'string' ? hash.replace(/^#/, '') : ''
  if (fragment) {
    candidates.push(fragment)
    const params = new URLSearchParams(fragment)
    candidates.push(params.get('tab'), params.get('section'))
  }
  for (const value of candidates) {
    if (typeof value === 'string' && Object.hasOwn(destinations, value)) return destinations[value]
  }
  return '/admin/channels'
}
