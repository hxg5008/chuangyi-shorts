import {currentActor,requireActor,assertProjectAccess,assertResourceAccess,actorForProject,runAsActor,denied} from './access.js'
import {userById,publicUser} from './store.js'
import {validateOwnedInput} from './middleware.js'
import {currentActivity} from '../activity/context.js'
import {assetWriteCategory,assetWriteScheduler} from '../asset-write-scheduler.js'

/** Preserve each original Tool and its schema; guard only its execution boundary. */
export function secureAgentTools<T extends Record<string,any>>(tools:T):T{
  return Object.fromEntries(Object.entries(tools).map(([name,tool])=>{
    if(!tool||typeof tool.execute!=='function')return[name,tool]
    const execute=tool.execute
    const wrapped=Object.create(Object.getPrototypeOf(tool),Object.getOwnPropertyDescriptors(tool))
    Object.defineProperty(wrapped,'execute',{configurable:true,enumerable:true,writable:true,value:async function(input:any,options:any,...rest:any[]){
      const rc=options?.requestContext
      const project=rc?.get?.('dramaId')
      if(!Number.isSafeInteger(project)||project<=0)throw denied('工具缺少可信项目上下文',403)
      const actorId=rc?.get?.('actorId'),persisted=Number.isSafeInteger(actorId)?userById(actorId):undefined
      const actor=currentActor()||(persisted?.enabled?publicUser(persisted):actorForProject(project))
      return runAsActor(actor,async()=>{
        const signals=[...new Set([currentActivity()?.abortSignal,options?.abortSignal].filter(Boolean))] as AbortSignal[]
        const signal=signals.length>1?AbortSignal.any(signals):signals[0]
        const validate=()=>{
          signal?.throwIfAborted()
          requireActor();assertProjectAccess(project,currentActor())
          const episode=rc?.get?.('episodeId');if(episode)assertResourceAccess('episode',episode,project,currentActor())
          validateOwnedInput(input,project)
          signal?.throwIfAborted()
        }
        const checked=async()=>{
          const fresh=userById(actor.id)
          if(!fresh?.enabled)throw denied('用户已停用',401)
          return runAsActor(publicUser(fresh),async()=>{
            validate()
            const result=await execute.call(tool,input,options,...rest)
            signal?.throwIfAborted()
            return result
          })
        }
        const category=assetWriteCategory(tool.id||name)
        if(!category)return checked()
        validate()
        return assetWriteScheduler.run(project,category,checked,signal)
      })
    }})
    return[name,wrapped]
  })) as T
}
