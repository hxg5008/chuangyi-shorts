/** Display only the server's saved timing budget; never recalculate from editor text. */
export function storyboardBudgetSummary(draft) {
  const budget = draft?.budget ?? draft?.plan?.budget
  if (!budget || typeof budget !== 'object') return null
  const { characters, targetSeconds, preferredGroups, minimumGroups, maximumGroups } = budget
  if (!Number.isSafeInteger(characters) || characters < 1 || !Number.isFinite(targetSeconds) || targetSeconds <= 0
    || !Number.isSafeInteger(preferredGroups) || preferredGroups < 1
    || !Number.isSafeInteger(minimumGroups) || minimumGroups < 1
    || !Number.isSafeInteger(maximumGroups) || maximumGroups < minimumGroups
    || preferredGroups < minimumGroups || preferredGroups > maximumGroups) return null
  const planned = draft?.plan?.data?.groups ?? draft?.plan?.groups
  const groups = Array.isArray(planned) ? planned : Array.isArray(draft?.groups) ? draft.groups : []
  const actualGroups = groups.length
  const durations = groups.map(group => group?.duration ?? group?.candidate?.duration)
  const totalSeconds = actualGroups && durations.every(duration => Number.isFinite(duration) && duration > 0)
    ? durations.reduce((sum, duration) => sum + duration, 0) : null
  const groupCountOutsideBudget = actualGroups > 0 && (actualGroups < minimumGroups || actualGroups > maximumGroups)
  const bodyScope = budget.scope === 'script-body-v1' ? {
    scope: budget.scope,
    ...(Number.isSafeInteger(budget.totalCharacters) && budget.totalCharacters >= characters ? { totalCharacters: budget.totalCharacters } : {}),
    ...(Number.isSafeInteger(budget.excludedCharacters) && budget.excludedCharacters >= 0 ? { excludedCharacters: budget.excludedCharacters } : {}),
    ...(Number.isSafeInteger(budget.excludedLineCount) && budget.excludedLineCount >= 0 ? { excludedLineCount: budget.excludedLineCount } : {}),
  } : {}
  return { characters, targetSeconds, preferredGroups, minimumGroups, maximumGroups, actualGroups, totalSeconds, groupCountOutsideBudget, ...bodyScope }
}

export function formatStoryboardBudgetNumber(value) {
  return Number.isFinite(value) ? String(Math.round((value + Number.EPSILON) * 100) / 100) : '—'
}

/** Public repair summaries only; never expose saved before/after draft snapshots. */
export function storyboardBoundaryRepairSummary(draft) {
  const labels = { running: '修复中', applied: '已修复', failed: '未修复' }
  if (!Array.isArray(draft?.boundaryRepairs)) return []
  return draft.boundaryRepairs
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry && Number.isSafeInteger(entry.left) && entry.left > 0
      && Number.isSafeInteger(entry.right) && entry.right === entry.left + 1
      && Object.hasOwn(labels, entry.status))
    .sort((a, b) => (Date.parse(b.entry.createdAt) || 0) - (Date.parse(a.entry.createdAt) || 0) || b.index - a.index)
    .slice(0, 5)
    .map(({ entry, index }) => ({
      key: typeof entry.id === 'string' ? entry.id : `${entry.left}-${entry.right}-${index}`,
      left: entry.left, right: entry.right, status: entry.status, label: labels[entry.status],
      error: entry.status === 'failed'
        ? (typeof entry.error === 'string' && entry.error.trim() ? entry.error
          : typeof entry.reason === 'string' ? entry.reason : '请查看运行日志中的具体原因。') : '',
    }))
}
