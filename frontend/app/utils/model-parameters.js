const reserved = /^(?:model|prompt|messages|instructions|system|tools|tool_choice|stream|credentials|api_?key|authorization|headers|url|base_?url|reference_?images?|reference_?videos?|reference_?audios?)$/iu
const protectedBinding = /(?:^|\.)(?:model|prompt|messages|instructions|system|tools|tool_choice|stream|headers|credentials|api_?key|authorization)(?:\.|$)/iu
export function parameterDefinitions(config, omit = []) {
  const rows = Array.isArray(config?.parameters) ? config.parameters : []
  return rows.map(row => ({ ...row, key: row.key || row.name, label: row.label || row.name || row.key }))
    .filter(row => row.key && !reserved.test(row.key) && !protectedBinding.test(typeof row.binding==='string'?row.binding:typeof row.path==='string'?row.path:'') && !omit.includes(row.key) && row.hidden !== true)
}
export function parameterOptions(field) {
  const raw = field.options ?? field.values
  const rows = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.entries(raw).map(([value,label]) => ({value,label})) : []
  return rows.map(item => typeof item === 'object' && item !== null ? { value: item.value ?? item.id ?? item.key ?? item.name, label: item.label ?? item.name ?? String(item.value ?? item.id ?? item.key) } : { value: item, label: String(item) })
}
export function initialModelParameters(config, previous = {}) {
  const definitions=parameterDefinitions(config),known=new Set(definitions.map(field=>field.key)),aliases={aspect_ratio:'aspectRatio',generate_audio:'generateAudio',prompt_extend:'promptExtend'},output={}
  const actualKey=key=>known.has(key)?key:known.has(aliases[key])?aliases[key]:key
  for (const [name,value] of Object.entries(config?.defaults || {})) { const key=actualKey(name);if(!definitions.length||known.has(key))output[key]=value }
  for (const field of definitions) if (output[field.key] === undefined && field.default !== undefined) output[field.key] = field.default
  for (const [name,value] of Object.entries(previous || {})) { const key=actualKey(name);if ((!definitions.length||known.has(key))&&!reserved.test(key) && value !== '' && value !== undefined && value !== null) output[key] = value }
  return Object.fromEntries(Object.entries(output).filter(([key,value]) => !reserved.test(key) && value !== '' && value !== undefined && value !== null))
}
export function modelParameterChoices(config, key, fallback = []) {
  const direct = config?.capabilities?.[key === 'resolution' ? 'resolutions' : key === 'aspect_ratio' ? 'aspect_ratios' : key === 'duration' ? 'durations' : key]
  if (Array.isArray(direct) && direct.length) return direct
  const field = parameterDefinitions(config).find(field => field.key === key || key==='aspect_ratio'&&field.key==='aspectRatio')
  const options = field ? parameterOptions(field).map(item => item.value) : []
  return options.length ? options : fallback
}
export function compareConfiguredDefaults(a, b) {
  const enabledDefault = config => config?.is_default === true || config?.is_default === 1 || config?.isDefault === true || config?.isDefault === 1
  return Number(enabledDefault(b)) - Number(enabledDefault(a))
    || (b.priority || 0) - (a.priority || 0) || Number(a.id || 0) - Number(b.id || 0)
}
export function resolveConfiguredSelection(configs, key = '', lockedId = null) {
  const active = (configs || []).filter(config => config.is_active !== false && config.is_active !== 0).sort(compareConfiguredDefaults)
  const models = config => { if (Array.isArray(config?.model)) return config.model; try { const raw=JSON.parse(config?.model||'[]');return Array.isArray(raw)?raw:[raw] } catch { return config?.model?[config.model]:[] } }
  for (const config of active) for (const model of models(config)) if (key === `${config.id}/${model}` || key === `${config.provider}/${model}`) return { config, model, configId: config.id, provider: config.provider }
  const config = active.find(item => Number(item.id) === Number(lockedId)) || active[0]
  return { config, model: models(config)[0], configId: config?.id, provider: config?.provider }
}
