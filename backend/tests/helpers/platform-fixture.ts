/** Only call after a test has selected its disposable data/SQLite directory. */
export async function platformFixtureOwner() {
  const {initPlatformSecurity,listUsers} = await import('../../src/services/platform-security/index.ts')
  initPlatformSecurity()
  const owner=listUsers().find(user=>user.role==='admin'&&user.enabled)
  if(!owner)throw new Error('Disposable fixture administrator was not initialized')
  return owner
}
