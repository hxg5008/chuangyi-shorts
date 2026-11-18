/** Process-local credential registry; never serialized and never used to alter model input. */
const values = new Set<string>()
export function registerRuntimeSecrets(secrets: unknown[]) {
  for (const raw of secrets) {
    if (typeof raw !== 'string' || raw.length < 4 || raw.length > 32768) continue
    values.add(raw)
    const token = /^(?:Bearer|Basic)\s+(.+)$/iu.exec(raw)?.[1]
    if (token && token.length >= 4) values.add(token)
  }
}
export function redactRuntimeSecrets(value: string) {
  let text = value
  for (const secret of values) text = text.split(secret).join('[凭据已隐藏]').split(encodeURIComponent(secret)).join('[凭据已隐藏]')
  return text.replace(/\b(?:sk-|sess-)[A-Za-z0-9_-]{6,}/gu, '[凭据已隐藏]').replace(/\bBearer\s+[^\s"'<>,;}]+/giu, 'Bearer [凭据已隐藏]')
}
