/** Resolve once before a single request or an entire batch. Never infer a
 * different account from the queue or fall back after a binding changes. */
export async function captureExecutionBinding(api,projectId,configId){
  if(!Number.isSafeInteger(Number(projectId))||Number(projectId)<1||!Number.isSafeInteger(Number(configId))||Number(configId)<1)throw Error('项目或视频模型尚未就绪，请刷新后再试。')
  const value=await api.get(`/dramas/${Number(projectId)}/execution-options?config_id=${Number(configId)}`)
  // Only an explicit server result can retain a legacy unscoped channel.
  // Authentication, network, paused-routing and malformed responses still fail.
  if(value.managed===false)return null
  if(value.pending)throw Error('项目画布正在建立，请先完成账号与画布绑定。')
  const current=value.current
  if(current?.state!=='ready'||!Number.isSafeInteger(current.id)||current.id<1)throw Error('请先在上方选择即梦账号与画布，并完成绑定。')
  if(current.permitted===false)throw Error(current.unavailable_reason||'当前账号已不在你的授权范围内，请重新选择可用账号。')
  return {id:current.id,configId:Number(configId)}
}
