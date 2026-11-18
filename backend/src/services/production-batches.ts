/** Durable orchestration around the existing extraction, asset-image and storyboard entry points. No filmmaking rules live here. */
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type Database from 'better-sqlite3'
import { db } from '../db/index.js'
import { startExtraction, getExtractionStatus, type ExtractTarget, type ExtractionLifecycleEvent } from './extraction.js'
import { getActiveConfig, getConfigById, assertConfigService, assertConfiguredModel, validateModelParameters } from './ai.js'
import { getContentLanguage } from './app-settings.js'
import { requireActor, assertProjectAccess, runAsActor, denied } from './platform-security/access.js'
import { userById, publicUser, type Actor } from './platform-security/store.js'
import { withActivityContext } from './activity/context.js'
import { createActivityTask, updateActivityTask, activityEvent, activitySource } from './activity/store.js'
import { initAssetImagePreparation } from './asset-image-preparation.js'
import { redactRuntimeSecrets } from '../utils/secret-redaction.js'
import { getDramaStyleSnapshot, conflictingStyleSnapshots, type StyleSnapshot } from './style-preset.js'

/**
 * Round 4 (2026-11-08, user-approved "按你建议来做"): besides the three extraction targets a batch may also run
 *  - `images`: the missing reference images of the characters, scenes and props linked to each episode, through the
 *    same asset-image preparation path as the episode page's 批量 buttons (one image job per asset, existing images are
 *    never regenerated, an asset shared by several episodes is generated once);
 *  - `storyboard`: the existing self-finishing storyboard job (拆分分镜) of each episode.
 * Inside one episode the order is 角色 → 场景 → 道具 → 出图 → 拆分镜. 出图 needs the episode's extraction; 拆分镜 needs the
 * extraction and waits until 出图 has ended (the storyboard reads the scene image prompts that 出图 writes), but a failed
 * image does not block the storyboard.
 */
export type BatchTarget = ExtractTarget | 'images' | 'storyboard'
export type ProductionStepStatus = 'queued' | 'running' | 'completed' | 'failed' | 'input_stale' | 'needs_review' | 'blocked'
export type ProductionBatchStatus = 'running' | 'paused' | 'completed' | 'completed_with_errors' | 'needs_review'
export interface ProductionCounts { total:number; queued:number; running:number; completed:number; failed:number; input_stale:number; needs_review:number; blocked:number; reused:number }
export interface ImagesStepResult { kind:'images'; total:number; needed:number; generated:number; skipped_existing:number; running?:boolean; failed:{asset_kind:AssetKind;asset_id:number;name:string;error_code:string;error:string}[] }
export interface StoryboardStepResult { kind:'storyboard'; job_id?:string; draft_id?:string; completed?:number; total?:number; skipped?:boolean }
export interface ProductionStep {
  id:string; batch_id:string; drama_id:number; episode_id:number; episode_number:number; target:BatchTarget; order_index:number
  status:ProductionStepStatus; attempt:number; activity_task_id:string|null; input_version:string; reused:boolean
  error:string|null; error_code:string|null; created_at:string; updated_at:string; started_at:string|null; finished_at:string|null
  receipt?:ExtractionReceipt
  result?:ImagesStepResult|StoryboardStepResult
}
export interface ProductionBatch {
  id:string; drama_id:number; user_id:number; status:ProductionBatchStatus; concurrency:1|2|4; config_id:number; model:string
  model_parameters:Record<string,unknown>; targets:BatchTarget[]; episode_ids:number[]; skip_completed:boolean
  image_config_id:number|null; image_model:string|null; image_concurrency:number; storyboard_concurrency:number
  created_at:string; updated_at:string; paused_at:string|null; finished_at:string|null; counts:ProductionCounts
}
export interface ProductionBatchDetail extends ProductionBatch { steps:ProductionStep[]; reused_batch?:boolean }
export type ProductionDashboardStep=Omit<ProductionStep,'input_version'|'receipt'|'order_index'>
export interface CreateProductionBatch {
  drama_id:number; episode_ids:number[]; targets?:BatchTarget[]; concurrency?:1|2|4; config_id?:number; model?:string
  model_parameters?:Record<string,unknown>; skip_completed?:boolean
  image_config_id?:number; image_model?:string; image_concurrency?:number; storyboard_concurrency?:number
}
interface BatchRow { id:string; drama_id:number; user_id:number; status:ProductionBatchStatus; concurrency:1|2|4; config_id:number; model:string; settings_json:string; created_at:string; updated_at:string; paused_at:string|null; finished_at:string|null }
interface StepRow extends Omit<ProductionStep,'reused'|'result'> { reused:number; attempt_key:string|null; receipt_json:string|null }
interface EpisodeRow { id:number; drama_id:number; episode_number:number; content:string|null; script_content:string|null; deleted_at:string|null }
interface Choice { configId:number; model:string; parameters:Record<string,unknown>; version:string }
type Starter = (episodeId:number, dramaId:number, target:ExtractTarget, opts:{model?:string;configId?:number;onLifecycle?:(event:ExtractionLifecycleEvent)=>void})=>boolean
export type AssetKind = 'character' | 'scene' | 'prop'
/** What the image entry point answered: a preparation job, a direct image task, or a refusal. */
export interface ImageSubmission { assetJobId?:string|null; imageGenerationId?:number|null; error?:string; status?:number; errorCode?:string }
export interface ImageOutcome { state:'pending'|'done'|'failed'; code?:string; message?:string }
export interface StoryboardJobView { id:string; status:string; completed?:number; total?:number; draft_id?:string; error?:string }
export interface ProductionBatchDependencies {
  startExtraction?:Starter
  recipeVersion?:()=>string
  resolveChoice?:(input:{config_id?:number;model?:string;model_parameters?:Record<string,unknown>},actor:Actor)=>Promise<Choice>
  /** Tests may delay dispatch; public requests never accept this switch. */
  autoDispatch?:boolean
  isExtractionRunning?:(episodeId:number,target:ExtractTarget)=>boolean
  /** Round 4 seams (tests replace them; production uses the real entry points). */
  submitAssetImage?:(kind:AssetKind,assetId:number,body:Record<string,unknown>)=>Promise<ImageSubmission>
  readImageOutcome?:(kind:AssetKind,assetId:number,submission:ImageSubmission)=>ImageOutcome
  startStoryboard?:(input:{agentType:'storyboard_breaker';episodeId:number;dramaId:number;message:string;model?:string;configId?:number})=>Promise<{job_id:string;already_running?:boolean}>
  readStoryboardJob?:(id:string)=>Promise<StoryboardJobView|null>|StoryboardJobView|null
  resolveImageChoice?:(input:{image_config_id?:number;image_model?:string},actor:Actor)=>Promise<{configId:number;model:string}|null>
  pollMs?:number
  /** Pauses before an image retry (15 s, then 45 s in production). */
  retryDelaysMs?:number[]
  /** Gap between two image submissions of one step, so a relay is not hit by a burst. */
  submitGapMs?:number
  /** Longest wait for one image (preparation plus generation). */
  imageWaitMs?:number
}
const targets:ExtractTarget[]=['characters','scenes','props']
const allTargets:BatchTarget[]=['characters','scenes','props','images','storyboard']
const isExtraction=(target:BatchTarget):target is ExtractTarget=>(targets as string[]).includes(target)
const labels:Record<BatchTarget,string>={characters:'角色',scenes:'场景',props:'道具',images:'出图',storyboard:'拆分镜'}
/** Same keywords as the episode page: a narrator is a voice, never drawn. */
const narrator=(row:{name?:string|null;role?:string|null})=>['旁白','画外音','narrator','ナレーター','ナレーション','내레이션','해설'].some(word=>`${row.name||''} ${row.role||''}`.toLowerCase().includes(word))
/** Image failures that a short pause can cure (relay burst refusal, rate limit, gateway error, prompt preparation hiccup) and the total attempts allowed. */
const imageRetryLimits:Record<string,number>={generation_auth_failed:1,generation_rate_limited:3,generation_provider_error:2,preparation_failed:2}
const stamp=()=>new Date().toISOString()
const clean=(error:unknown)=>redactRuntimeSecrets(String((error as any)?.message||error||'任务未完成'))
function canonical(value:any):string {
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']'
  if(value&&typeof value==='object')return '{'+Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}'
  return JSON.stringify(value)??'null'
}
const digest=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex')
function validId(value:unknown,label:string):number {if(typeof value!=='number'||!Number.isSafeInteger(value)||value<=0)throw denied(`${label} 必须为正整数`,400);return value}
function settings(row:BatchRow){return JSON.parse(row.settings_json) as {targets:BatchTarget[];episode_ids:number[];parameters:Record<string,unknown>;skip_completed:boolean;image_config_id?:number|null;image_model?:string|null;image_concurrency?:number;storyboard_concurrency?:number;style_snapshot?:StyleSnapshot|null}}
function safeStep(row:StepRow):ProductionStep {const {attempt_key,receipt_json,...rest}=row;let receipt:ExtractionReceipt|undefined,result:ImagesStepResult|StoryboardStepResult|undefined;try{const value=JSON.parse(receipt_json||'null');if(value?.ok===true)receipt={ok:true,failed:false,saved_calls:value.saved_calls,created:value.created,merged:value.merged,reused:value.reused};else if(value?.kind==='images'||value?.kind==='storyboard')result=value}catch{}return {...rest,reused:!!row.reused,...(receipt?{receipt}:{}),...(result?{result}:{})}}

/** Fingerprinting observes current sources; it never loads, strips, patches or supplies an Agent instruction. */
function extractionRecipeVersion():string {
  const srcRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
  const workspace=process.env.WORKSPACE_PATH?path.resolve(process.env.WORKSPACE_PATH):path.resolve(srcRoot,'../workspace')
  const entries:[string,string][]=[]
  for(const file of ['services/extraction.ts','agents/index.ts','agents/context.ts','agents/skills.ts','agents/prompts.ts','agents/tools/extract-tools.ts','services/character-voice-card.ts','services/character-voice-card-align.ts']) {
    const absolute=path.join(srcRoot,file);entries.push([file,fs.existsSync(absolute)?fs.readFileSync(absolute,'utf8'):'<missing>'])
  }
  const promptDir=path.join(workspace,'prompts')
  if(fs.existsSync(promptDir))for(const name of fs.readdirSync(promptDir).filter(name=>/^extractor(?:\.[^.]+)?\.md$/u.test(name)).sort())entries.push(['prompts/'+name,fs.readFileSync(path.join(promptDir,name),'utf8')])
  const walk=(directory:string,relative:string)=>{if(!fs.existsSync(directory))return;for(const entry of fs.readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
    const absolute=path.join(directory,entry.name),rel=relative+'/'+entry.name
    if(entry.isDirectory())walk(absolute,rel)
    else if(entry.isFile()&&/^SKILL(?:\.[^.]+)?\.md$/u.test(entry.name))entries.push([rel,fs.readFileSync(absolute,'utf8')])
  }}
  walk(path.join(workspace,'skills','extractor'),'skills/extractor')
  return digest({entries,language:getContentLanguage()})
}
async function resolveChoice(input:{config_id?:number;model?:string;model_parameters?:Record<string,unknown>},actor:Actor):Promise<Choice> {
  return runAsActor(actor,async()=>{
    const config=input.config_id?await getConfigById(input.config_id):await getActiveConfig('text')
    if(!config)throw denied('未配置可用的文字模型',400)
    assertConfigService(config,'text')
    const model=assertConfiguredModel(config,input.model),parameters=validateModelParameters(config,input.model_parameters)
    return {configId:config.id!,model,parameters,version:digest({id:config.id,binding:config.bindingId,provider:config.provider,protocol:config.protocolId,definition:config.protocolDefinition,model,parameters,
      connection:{baseUrl:config.baseUrl,apiKey:config.apiKey,headers:config.headers,authFields:config.authFields},defaults:config.defaults,capabilities:config.capabilities})}
  })
}
/** Round 4: the image model chosen for the batch (an explicit binding, else the episode's own locked image config). */
async function resolveImageChoice(input:{image_config_id?:number;image_model?:string},actor:Actor):Promise<{configId:number;model:string}|null>{
  if(!input.image_config_id)return null
  return runAsActor(actor,async()=>{
    const config=await getConfigById(input.image_config_id!)
    if(!config)throw denied('所选图片模型已停用、删除或未获授权',400)
    assertConfigService(config,'image')
    return {configId:config.id!,model:assertConfiguredModel(config,input.image_model)}
  })
}
/** Round 4: one asset image through the same preparation route as the episode page (async_prepare:true). */
async function submitAssetImage(kind:AssetKind,assetId:number,body:Record<string,unknown>):Promise<ImageSubmission>{
  const routes=kind==='character'?(await import('../routes/characters.js')).default:kind==='scene'?(await import('../routes/scenes.js')).default:(await import('../routes/props.js')).default
  const response=await routes.request(`/${assetId}/generate-image`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...body,async_prepare:true})})
  let value:any=null;try{value=await response.json()}catch{/* handled below */}
  if(!response.ok||value?.code&&![200,201,202].includes(value.code))return {error:String(value?.message||`HTTP ${response.status}`),status:response.status,...(value?.error_code==='image_style_conflict'?{errorCode:'image_style_conflict'}:{})}
  return {assetJobId:value?.data?.asset_job_id??null,imageGenerationId:Number(value?.data?.image_generation_id)||null}
}
/** Round 4: the current state of one submitted asset image (preparation job → image task → asset image_url). */
function readImageOutcome(kind:AssetKind,assetId:number,submission:ImageSubmission):ImageOutcome{
  const table=kind==='character'?'characters':kind==='scene'?'scenes':'props'
  const asset=db.$client.prepare(`SELECT image_url FROM ${table} WHERE id=?`).get(assetId) as {image_url:string|null}|undefined
  let taskId=submission.imageGenerationId||null
  if(submission.assetJobId){
    const job=db.$client.prepare('SELECT status,image_generation_id,error,error_code FROM platform_asset_image_jobs WHERE id=?').get(submission.assetJobId) as any
    if(job?.status==='preparing_prompt')return {state:'pending'}
    if(job&&['failed','interrupted'].includes(job.status))return {state:'failed',code:job.error_code||'preparation_failed',message:job.error||'图片提示词准备未完成'}
    taskId=job?.image_generation_id||taskId
  }
  if(taskId){
    const task=db.$client.prepare('SELECT status,error_code,error_msg FROM sys_task WHERE id=?').get(taskId) as any
    if(task?.status==='completed')return asset?.image_url?{state:'done'}:{state:'failed',code:'image_not_saved',message:'图片任务已完成，但素材上没有图片'}
    if(task?.status==='failed')return {state:'failed',code:task.error_code||'generation_failed',message:task.error_msg||'图片生成失败'}
    return {state:'pending'}
  }
  return asset?.image_url?{state:'done'}:{state:'pending'}
}
/** Round 4: the same message the episode page's 拆分分镜 button sends (episode.vue doBreakdown), built from the episode's linked assets. */
export function storyboardBreakdownMessage(episodeId:number, sql:Database.Database=db.$client){
  const linked=(table:string,link:string,column:string,order='t.id')=>sql.prepare(`SELECT t.* FROM ${table} t WHERE t.deleted_at IS NULL AND t.id IN (SELECT ${column} FROM ${link} WHERE episode_id=?) ORDER BY ${order}`).all(episodeId) as any[]
  const chars=linked('characters','episode_characters','character_id'),scenes=linked('scenes','episode_scenes','scene_id'),props=linked('props','episode_props','prop_id')
  const episode=sql.prepare('SELECT video_config_id FROM episodes WHERE id=?').get(episodeId) as {video_config_id:number|null}|undefined
  const video=episode?.video_config_id?sql.prepare("SELECT model FROM ai_service_configs WHERE id=? AND service_type='video'").get(episode.video_config_id) as {model:string}|undefined:undefined
  let videoLabel='';try{const models=JSON.parse(video?.model||'[]');videoLabel=String((Array.isArray(models)?models[0]:models)||'')}catch{videoLabel=''}
  const charList=chars.length?chars.map(c=>`${c.name}(ID:${c.id})`).join('、'):'（当前集还没有角色）'
  const sceneList=scenes.length?scenes.map(s=>`${s.location} · ${s.time||'未设时间'}(ID:${s.id})`).join('、'):'（当前集还没有场景）'
  const propList=props.length?props.map(p=>`${p.name}(ID:${p.id})`).join('、'):'（当前集还没有道具）'
  return `请基于当前集剧本拆分分镜，并为每个分镜段落同时生成 video_prompt（视频生成提示词）。
本次视频模型：${videoLabel}，请按该模型的特性与时长限制生成 video_prompt。

当前集已有角色：${charList}
当前集已有场景：${sceneList}
当前集已有道具：${propList}

绑定要求：
- 每个镜头必须根据剧本内容，从上述当前集已有角色中选出出场的角色绑定 character_ids（ID 必须来自上述列表；有角色出场就必须绑定，不要遗漏）
- 每个镜头尽量匹配上述已有场景填写 scene_id（ID 必须来自上述列表），不要凭空创造新场景
- 每个镜头出现关键道具（被使用、交接、特写或在画面中明显可见）时，从上述当前集已有道具中绑定 prop_ids（ID 必须来自上述列表）；没有道具出现可传空数组
- 只有纯环境空镜头才可以不绑定角色`
}
async function startStoryboard(input:{agentType:'storyboard_breaker';episodeId:number;dramaId:number;message:string;model?:string;configId?:number}){
  const {startValidatedAgentJob}=await import('./agent-jobs.js')
  return startValidatedAgentJob(input)
}
async function readStoryboardJob(id:string):Promise<StoryboardJobView|null>{
  const {agentJobStore}=await import('./agent-jobs.js')
  return agentJobStore.get(id) as StoryboardJobView|null
}

export interface ExtractionReceipt { ok:boolean; failed:boolean; saved_calls:number; created:number; merged:number; reused:number; error?:string }
/** Accept only the real target save-tool outputs, including explicit successful zero-item saves. */
export function extractionSaveReceipt(target:ExtractTarget,observed:any[],result:any):ExtractionReceipt {
  const expected=new Set(['save_dedup_'+target,'saveDedup'+target[0].toUpperCase()+target.slice(1)]),calls=new Map<string,string>(),outputs:any[]=[],seen=new Set<any>()
  const visit=(node:any,depth=0)=>{
    if(!node||typeof node!=='object'||depth>12||seen.has(node))return;seen.add(node)
    for(const call of Array.isArray(node.toolCalls)?node.toolCalls:[]){const payload=call?.payload||call,id=call?.toolCallId||call?.id||payload?.toolCallId||payload?.id,name=call?.toolName||payload?.toolName||payload?.name;if(id&&name)calls.set(String(id),String(name))}
    for(const output of Array.isArray(node.toolResults)?node.toolResults:[])outputs.push(output)
    for(const step of Array.isArray(node.steps)?node.steps:[])visit(step,depth+1)
    if(node.payload&&typeof node.payload==='object')visit(node.payload,depth+1)
  }
  for(const step of observed)visit(step);visit(result)
  let saved=0,created=0,merged=0,reused=0,failed=false,error:string|undefined
  const unique=new Set<string>()
  for(const output of outputs){
    const payload=output?.payload||output,id=output?.toolCallId||output?.id||payload?.toolCallId||payload?.id
    const name=output?.toolName||payload?.toolName||payload?.name||(id&&calls.get(String(id)))
    let value=output?.result??payload?.result??output?.output??payload?.output??output?.data
    if(typeof value==='string'){try{value=JSON.parse(value)}catch{/* isError is still authoritative for non-JSON tool errors. */}}
    // Match the existing Agent activity observer's business-error semantics for every tool.
    if(output?.isError||payload?.isError||value?.error){failed=true;error=clean(value?.error||'业务工具返回失败');continue}
    if(!expected.has(name))continue
    const identity=id?String(id):digest({name,value})
    if(unique.has(identity))continue;unique.add(identity)
    const alternate=target==='scenes'?'reused':'merged'
    if(!value||!Number.isSafeInteger(value.created)||value.created<0||!Number.isSafeInteger(value[alternate])||value[alternate]<0)continue
    saved++;created+=value.created;merged+=value.merged||0;reused+=value.reused||0
  }
  return {ok:saved>0&&!failed,failed,saved_calls:saved,created,merged,reused,...(error?{error}:{})}
}

export class ProductionBatchManager {
  private readonly starter:Starter
  private readonly version:()=>string
  private readonly resolve:NonNullable<ProductionBatchDependencies['resolveChoice']>
  private readonly submitImage:NonNullable<ProductionBatchDependencies['submitAssetImage']>
  private readonly imageOutcome:NonNullable<ProductionBatchDependencies['readImageOutcome']>
  private readonly beginStoryboard:NonNullable<ProductionBatchDependencies['startStoryboard']>
  private readonly storyboardJob:NonNullable<ProductionBatchDependencies['readStoryboardJob']>
  private readonly resolveImage:NonNullable<ProductionBatchDependencies['resolveImageChoice']>
  /** Long-running image/storyboard steps owned by this process (attempt key → run promise). */
  private readonly runs=new Map<string,Promise<void>>()
  private pumping=false
  private scheduled=false
  private closed=false
  private wake:ReturnType<typeof setTimeout>|undefined
  private busyUntil=new Map<string,number>()
  constructor(private readonly sql:Database.Database=db.$client,private readonly deps:ProductionBatchDependencies={}) {
    this.starter=deps.startExtraction||startExtraction;this.version=deps.recipeVersion||extractionRecipeVersion;this.resolve=deps.resolveChoice||resolveChoice
    this.submitImage=deps.submitAssetImage||submitAssetImage;this.imageOutcome=deps.readImageOutcome||readImageOutcome
    this.beginStoryboard=deps.startStoryboard||startStoryboard;this.storyboardJob=deps.readStoryboardJob||readStoryboardJob;this.resolveImage=deps.resolveImageChoice||resolveImageChoice
    sql.exec(`CREATE TABLE IF NOT EXISTS platform_production_batches(
      id TEXT PRIMARY KEY,drama_id INTEGER NOT NULL,user_id INTEGER NOT NULL,status TEXT NOT NULL,concurrency INTEGER NOT NULL,
      config_id INTEGER NOT NULL,model TEXT NOT NULL,settings_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,paused_at TEXT,finished_at TEXT);
      CREATE INDEX IF NOT EXISTS idx_production_batch_project ON platform_production_batches(drama_id,created_at);
      CREATE TABLE IF NOT EXISTS platform_production_steps(
      id TEXT PRIMARY KEY,batch_id TEXT NOT NULL,drama_id INTEGER NOT NULL,episode_id INTEGER NOT NULL,episode_number INTEGER NOT NULL,target TEXT NOT NULL,
      order_index INTEGER NOT NULL,status TEXT NOT NULL,attempt INTEGER NOT NULL DEFAULT 0,attempt_key TEXT,activity_task_id TEXT,input_version TEXT NOT NULL,
      receipt_json TEXT,reused INTEGER NOT NULL DEFAULT 0,error TEXT,error_code TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,started_at TEXT,finished_at TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_production_step_identity ON platform_production_steps(batch_id,episode_id,target);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_production_step_active ON platform_production_steps(episode_id,target) WHERE status='running';
      CREATE INDEX IF NOT EXISTS idx_production_step_batch ON platform_production_steps(batch_id,status,order_index);
      CREATE TABLE IF NOT EXISTS platform_production_receipts(
      episode_id INTEGER NOT NULL,target TEXT NOT NULL,input_version TEXT NOT NULL,output_version TEXT NOT NULL,step_id TEXT NOT NULL,
      activity_task_id TEXT NOT NULL,receipt_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(episode_id,target,input_version));`)
  }
  private row(id:string){return this.sql.prepare('SELECT * FROM platform_production_batches WHERE id=?').get(id) as BatchRow|undefined}
  private frozenStyle(batch:BatchRow):StyleSnapshot|null {
    const current=this.row(batch.id)||batch,opts=settings(current)
    if(Object.hasOwn(opts,'style_snapshot'))return structuredClone(opts.style_snapshot||null)
    // Existing pre-v4 queued batches acquire one snapshot on first visual dispatch; no model request is replayed.
    const snapshot=getDramaStyleSnapshot(batch.drama_id)
    this.sql.prepare("UPDATE platform_production_batches SET settings_json=json_set(settings_json,'$.style_snapshot',json(?)) WHERE id=? AND json_type(settings_json,'$.style_snapshot') IS NULL").run(JSON.stringify(snapshot),batch.id)
    return structuredClone(settings(this.row(batch.id)||current).style_snapshot||null)
  }
  private step(id:string){return this.sql.prepare('SELECT * FROM platform_production_steps WHERE id=?').get(id) as StepRow|undefined}
  private steps(id:string){return this.sql.prepare('SELECT * FROM platform_production_steps WHERE batch_id=? ORDER BY order_index').all(id) as StepRow[]}
  private check(id:string,actor:Actor){const row=this.row(id);if(!row)throw denied('批次不存在或无访问权限',404);assertProjectAccess(row.drama_id,actor);if(actor.role!=='admin'&&row.user_id!==actor.id)throw denied('批次不存在或无访问权限',404);return row}
  private episode(id:number,project:number):EpisodeRow {const row=this.sql.prepare('SELECT id,drama_id,episode_number,content,script_content,deleted_at FROM episodes WHERE id=?').get(id) as EpisodeRow|undefined;if(!row||row.deleted_at||row.drama_id!==project)throw denied('剧集不存在或不属于当前项目',404);if(!(row.script_content||row.content)?.trim())throw denied(`第${row.episode_number}集没有可提取的剧本或原文`,400);return row}
  private inputVersion(episode:EpisodeRow,target:BatchTarget,choice:Choice,recipe:string){
    // An image or storyboard step depends on the episode and the models chosen, not on the extraction recipe; its real
    // inputs (assets, script) are read when it runs, after the earlier steps of the same episode.
    if(!isExtraction(target))return digest({episode:episode.id,target,choice:choice.version})
    return digest({episode:episode.id,source:episode.script_content?'script_content':'content',content:episode.script_content||episode.content,target,choice:choice.version,recipe})
  }
  private outputVersion(episodeId:number,target:ExtractTarget){
    const table={characters:'characters',scenes:'scenes',props:'props'}[target],join={characters:'episode_characters',scenes:'episode_scenes',props:'episode_props'}[target],field={characters:'character_id',scenes:'scene_id',props:'prop_id'}[target]
    // A receipt is not reusable after its actual saved/linked output has been removed or edited.
    const columns=target==='characters'?'a.id,a.name,a.role,a.description,a.appearance,a.styling,a.voice_card':target==='scenes'?'a.id,a.location,a.time,a.prompt,a.lighting':'a.id,a.name,a.type,a.description'
    const rows=this.sql.prepare(`SELECT ${columns} FROM ${table} a JOIN ${join} l ON l.${field}=a.id WHERE l.episode_id=? AND a.deleted_at IS NULL ORDER BY a.id`).all(episodeId)
    return digest(rows)
  }
  private receipt(step:StepRow){if(!isExtraction(step.target))return null;const row=this.sql.prepare('SELECT * FROM platform_production_receipts WHERE episode_id=? AND target=? AND input_version=?').get(step.episode_id,step.target,step.input_version) as any;return row&&row.output_version===this.outputVersion(step.episode_id,step.target)?row:null}
  private counts(id:string):ProductionCounts {const value:ProductionCounts={total:0,queued:0,running:0,completed:0,failed:0,input_stale:0,needs_review:0,blocked:0,reused:0};for(const row of this.sql.prepare('SELECT status,count(*) n,sum(reused) reused FROM platform_production_steps WHERE batch_id=? GROUP BY status').all(id) as any[]){value[row.status as ProductionStepStatus]+=row.n;value.total+=row.n;value.reused+=row.reused||0}return value}
  private view(row:BatchRow):ProductionBatch {const opts=settings(row);return {id:row.id,drama_id:row.drama_id,user_id:row.user_id,status:row.status,concurrency:row.concurrency,config_id:row.config_id,model:row.model,model_parameters:opts.parameters,targets:opts.targets,episode_ids:opts.episode_ids,skip_completed:opts.skip_completed,
    image_config_id:opts.image_config_id??null,image_model:opts.image_model??null,image_concurrency:opts.image_concurrency??3,storyboard_concurrency:opts.storyboard_concurrency??1,
    created_at:row.created_at,updated_at:row.updated_at,paused_at:row.paused_at,finished_at:row.finished_at,counts:this.counts(row.id)}}
  get(id:string,actor:Actor=requireActor()):ProductionBatchDetail {const row=this.check(id,actor);return {...this.view(row),steps:this.steps(id).map(safeStep)}}
  list(filters:{dramaId?:number;limit?:number}={},actor:Actor=requireActor()):ProductionBatch[]{
    if(filters.dramaId)assertProjectAccess(filters.dramaId,actor)
    const limit=Math.min(200,Math.max(1,Number(filters.limit)||50)),where:string[]=[],args:any[]=[]
    if(filters.dramaId){where.push('b.drama_id=?');args.push(filters.dramaId)}
    if(actor.role!=='admin'){where.push('b.user_id=?','d.owner_user_id=?');args.push(actor.id,actor.id)}
    where.push('d.deleted_at IS NULL');args.push(limit)
    return (this.sql.prepare(`SELECT b.* FROM platform_production_batches b JOIN dramas d ON d.id=b.drama_id WHERE ${where.join(' AND ')} ORDER BY b.created_at DESC,b.rowid DESC LIMIT ?`).all(...args) as BatchRow[]).map(row=>this.view(row))
  }
  dashboard(projectIds:number[],actor:Actor=requireActor()):ProductionDashboardStep[]{
    if(!Array.isArray(projectIds)||!projectIds.length)return[]
    const ids=[...new Set(projectIds.map(id=>validId(id,'project_id')))];for(const id of ids)assertProjectAccess(id,actor)
    const owner=actor.role==='admin'?'':' AND b.user_id=?',args:any[]=[...ids,...(actor.role==='admin'?[]:[actor.id])]
    return (this.sql.prepare(`SELECT s.id,s.batch_id,s.drama_id,s.episode_id,s.episode_number,s.target,s.status,s.attempt,s.activity_task_id,s.reused,s.error,s.error_code,s.created_at,s.updated_at,s.started_at,s.finished_at
      FROM platform_production_steps s JOIN platform_production_batches b ON b.id=s.batch_id WHERE b.drama_id IN (${ids.map(()=>'?').join(',')})${owner} ORDER BY s.updated_at DESC,s.rowid DESC`).all(...args) as any[]).map(row=>({...row,reused:!!row.reused}))
  }
  async create(input:CreateProductionBatch,actor:Actor=requireActor()):Promise<ProductionBatchDetail>{
    if(!input||typeof input!=='object'||Array.isArray(input))throw denied('请提交批次参数',400)
    const project=validId(input.drama_id,'drama_id');assertProjectAccess(project,actor)
    if(!Array.isArray(input.episode_ids)||!input.episode_ids.length||input.episode_ids.length>1000)throw denied('请选择1至1000个剧集',400)
    const ids=[...new Set(input.episode_ids.map(id=>validId(id,'episode_id')))],requested=input.targets??targets
    if(!Array.isArray(requested)||!requested.length||requested.some(target=>!allTargets.includes(target)))throw denied('target 必须是 characters / scenes / props / images / storyboard',400)
    const chosen=allTargets.filter(target=>requested.includes(target)),concurrency=input.concurrency??1
    if(![1,2,4].includes(concurrency))throw denied('并发必须为1、2或4',400)
    if(input.skip_completed!==undefined&&typeof input.skip_completed!=='boolean')throw denied('skip_completed 必须为布尔值',400)
    if(input.config_id!==undefined)validId(input.config_id,'config_id')
    if(input.image_config_id!==undefined)validId(input.image_config_id,'image_config_id')
    const imageConcurrency=input.image_concurrency??3,storyboardConcurrency=input.storyboard_concurrency??1
    if(![1,2,3,4].includes(imageConcurrency))throw denied('同时出图数必须为1至4',400)
    if(![1,2].includes(storyboardConcurrency))throw denied('同时拆分镜集数必须为1或2',400)
    const episodes=ids.map(id=>this.episode(id,project)).sort((a,b)=>a.episode_number-b.episode_number||a.id-b.id)
    const choice=await this.resolve(input,actor),recipe=this.version(),at=stamp(),id=randomUUID(),skip=input.skip_completed!==false
    const image=chosen.includes('images')?await this.resolveImage({image_config_id:input.image_config_id,image_model:input.image_model},actor):null
    const styleSnapshot=chosen.some(target=>target==='images'||target==='storyboard')?structuredClone(getDramaStyleSnapshot(project)):null
    let batchId:string=id,reusedBatch=false
    this.sql.transaction(()=>{
      assertProjectAccess(project,actor)
      const freshEpisodes=episodes.map(ep=>this.episode(ep.id,project)),creationVersion=digest({owner:actor.id,project,concurrency,skip,choice:choice.version,targets:chosen,
        ...(chosen.includes('images')?{image:image?{config:image.configId,model:image.model}:'episode',imageConcurrency}:{}),...(chosen.includes('storyboard')?{storyboardConcurrency}:{}),...(chosen.some(target=>target==='images'||target==='storyboard')?{styleSnapshot}:{}),
        episodes:freshEpisodes.map(ep=>({id:ep.id,number:ep.episode_number,inputs:chosen.map(target=>this.inputVersion(ep,target,choice,recipe))}))})
      const existing=this.sql.prepare("SELECT id FROM platform_production_batches WHERE user_id=? AND drama_id=? AND status IN('running','paused','needs_review') AND json_extract(settings_json,'$.creation_version')=? ORDER BY rowid DESC LIMIT 1").get(actor.id,project,creationVersion) as {id:string}|undefined
      if(existing){batchId=existing.id;reusedBatch=true;return}
      this.sql.prepare(`INSERT INTO platform_production_batches(id,drama_id,user_id,status,concurrency,config_id,model,settings_json,created_at,updated_at) VALUES(?,?,?,'running',?,?,?,?,?,?)`).run(id,project,actor.id,concurrency,choice.configId,choice.model,JSON.stringify({targets:chosen,episode_ids:freshEpisodes.map(ep=>ep.id),parameters:choice.parameters,skip_completed:skip,creation_version:creationVersion,style_snapshot:styleSnapshot,
        ...(chosen.includes('images')?{image_config_id:image?.configId??null,image_model:image?.model??null,image_concurrency:imageConcurrency}:{}),...(chosen.includes('storyboard')?{storyboard_concurrency:storyboardConcurrency}:{})}),at,at)
      let order=0
      for(const ep of freshEpisodes)for(const target of chosen){const stepId=randomUUID(),version=this.inputVersion(ep,target,choice,recipe)
        this.sql.prepare(`INSERT INTO platform_production_steps(id,batch_id,drama_id,episode_id,episode_number,target,order_index,status,input_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'queued',?,?,?)`).run(stepId,id,project,ep.id,ep.episode_number,target,order++,version,at,at)
        if(skip){const step=this.step(stepId)!,receipt=this.receipt(step);if(receipt)this.useReceipt(step,receipt)}
      }
      this.refresh(id)
    }).immediate()
    this.kick();return {...this.get(batchId,actor),reused_batch:reusedBatch}
  }
  private useReceipt(step:StepRow,receipt:any){const at=stamp();this.sql.prepare("UPDATE platform_production_steps SET status='completed',reused=1,receipt_json=?,activity_task_id=?,updated_at=?,finished_at=? WHERE id=? AND status='queued'").run(receipt.receipt_json,receipt.activity_task_id,at,at,step.id)}
  private refresh(id:string){
    const batch=this.row(id);if(!batch)return
    // A failure stops only the remaining targets in this episode. Other episodes keep their slots. Round 4: a failed
    // 出图 step does not stop the storyboard (it only needs the extraction), so it is excluded as a blocker for it.
    this.sql.prepare(`UPDATE platform_production_steps AS s SET status='blocked',error='本集前序步骤未完成，等待处理；其他剧集继续。',error_code='previous_step_incomplete',updated_at=?
      WHERE s.batch_id=? AND s.status='queued' AND EXISTS(SELECT 1 FROM platform_production_steps p WHERE p.batch_id=s.batch_id AND p.episode_id=s.episode_id AND p.order_index<s.order_index AND p.status IN('failed','input_stale','needs_review','blocked')
        AND NOT (s.target='storyboard' AND p.target='images'))`).run(stamp(),id)
    const counts=this.counts(id);let status:ProductionBatchStatus=batch.status
    if(batch.status!=='paused')status=counts.running||counts.queued?'running':counts.needs_review?'needs_review':counts.failed||counts.input_stale||counts.blocked?'completed_with_errors':'completed'
    const at=stamp(),terminal=!counts.running&&!counts.queued
    this.sql.prepare('UPDATE platform_production_batches SET status=?,updated_at=?,finished_at=? WHERE id=?').run(status,at,terminal?batch.finished_at||at:null,id)
  }
  pause(id:string,actor:Actor=requireActor()){this.check(id,actor);const at=stamp();this.sql.prepare("UPDATE platform_production_batches SET status='paused',paused_at=?,updated_at=? WHERE id=?").run(at,at,id);return this.get(id,actor)}
  resume(id:string,actor:Actor=requireActor()){this.check(id,actor);this.sql.prepare("UPDATE platform_production_batches SET status='running',paused_at=NULL,finished_at=NULL,updated_at=? WHERE id=?").run(stamp(),id);this.refresh(id);this.kick();return this.get(id,actor)}
  async retry(id:string,stepIds?:string[],actor:Actor=requireActor()){
    if(stepIds!==undefined&&(!Array.isArray(stepIds)||!stepIds.length||stepIds.some(id=>typeof id!=='string')))throw denied('请选择本批次可重试的步骤',400)
    // Round 4: an image or storyboard step that needs review (after a restart) may be retried too — both are safe to
    // repeat: images only fills assets that still have no image and no active job; a storyboard resumes its saved draft.
    const retryable=(row:StepRow)=>['failed','input_stale'].includes(row.status)||!isExtraction(row.target)&&row.status==='needs_review'
    const batch=this.check(id,actor),rows=this.steps(id),requested=stepIds===undefined?rows.filter(retryable):rows.filter(row=>stepIds.includes(row.id))
    if(stepIds!==undefined&&(!Array.isArray(stepIds)||!stepIds.length||requested.length!==new Set(stepIds).size))throw denied('请选择本批次可重试的步骤',400)
    if(!requested.length||requested.some(row=>!retryable(row)))throw denied('只能重试已确定失败或输入已过期的步骤；待核对任务不会重新提交',409)
    const options=settings(batch),choice=await this.resolve({config_id:batch.config_id,model:batch.model,model_parameters:options.parameters},actor),recipe=this.version()
    const versions=requested.map(step=>({step,version:this.inputVersion(this.episode(step.episode_id,batch.drama_id),step.target,choice,recipe)})),at=stamp()
    this.sql.transaction(()=>{
      assertProjectAccess(batch.drama_id,actor)
      for(const {step,version} of versions)this.sql.prepare("UPDATE platform_production_steps SET status='queued',input_version=?,attempt_key=NULL,receipt_json=NULL,reused=0,error=NULL,error_code=NULL,started_at=NULL,finished_at=NULL,updated_at=? WHERE id=? AND status IN('failed','input_stale','needs_review')").run(version,at,step.id)
      for(const episodeId of new Set(requested.map(row=>row.episode_id)))this.sql.prepare("UPDATE platform_production_steps SET status='queued',error=NULL,error_code=NULL,finished_at=NULL,updated_at=? WHERE batch_id=? AND episode_id=? AND status='blocked'").run(at,id,episodeId)
      this.sql.prepare("UPDATE platform_production_batches SET status='running',paused_at=NULL,finished_at=NULL,updated_at=? WHERE id=?").run(at,id);this.refresh(id)
    }).immediate();this.kick();return this.get(id,actor)
  }
  /** No submitted operation is replayed at startup. A person must resume the remaining queued work. */
  recoverInterrupted(){
    const rows=this.sql.prepare("SELECT * FROM platform_production_steps WHERE status='running'").all() as StepRow[],at=stamp()
    this.sql.transaction(()=>{
      for(const row of rows){
        // Round 4: an interrupted image step left its submitted images running on their own (they finish or fail by
        // themselves); a storyboard job is marked ended by its own store and its draft stays resumable. Either can be
        // retried from the batch without double spending.
        const message=isExtraction(row.target)?'服务已重启，上次执行结果待核对；未自动重新提交。':row.target==='images'?'服务已重启，本集出图的协调已中断；已提交的图片会继续完成，可点重试补出剩余图片。':'服务已重启，本集分镜任务已中断，草稿已保留；可点重试接着生成。'
        this.sql.prepare("UPDATE platform_production_steps SET status='needs_review',error=?,error_code='restart_interrupted',updated_at=?,finished_at=? WHERE id=? AND status='running'").run(message,at,at,row.id);if(row.activity_task_id){updateActivityTask(row.activity_task_id,{status:'interrupted',stage:'needs_review',error:message});activityEvent(row.activity_task_id,'interrupted',message)}}
      this.sql.prepare("UPDATE platform_production_batches SET status='paused',paused_at=?,updated_at=? WHERE status='running' OR id IN(SELECT batch_id FROM platform_production_steps WHERE error_code='restart_interrupted')").run(at,at)
      for(const batch of this.sql.prepare("SELECT id FROM platform_production_batches WHERE status='paused'").all() as {id:string}[])this.refresh(batch.id)
    }).immediate();return{interrupted:rows.length}
  }
  private kick(){if(this.closed||this.deps.autoDispatch===false||this.scheduled)return;this.scheduled=true;queueMicrotask(()=>{this.scheduled=false;void this.pump().catch(()=>{/* A dispatch error must never trigger a duplicate model submission. */})})}
  private later(){if(this.closed||this.deps.autoDispatch===false||this.wake)return;this.wake=setTimeout(()=>{this.wake=undefined;this.kick()},1500);this.wake.unref()}
  /** Running steps of one batch (or of all batches) of one kind: the extraction text slots, the image step, the storyboard steps. */
  private runningCount(batchId:string|null,kind:'extraction'|'images'|'storyboard'){
    const where=kind==='extraction'?"target IN('characters','scenes','props')":`target='${kind}'`
    return (batchId?this.sql.prepare(`SELECT count(*) n FROM platform_production_steps WHERE status='running' AND batch_id=? AND ${where}`).get(batchId):this.sql.prepare(`SELECT count(*) n FROM platform_production_steps WHERE status='running' AND ${where}`).get() as any).n as number
  }
  /**
   * Extraction keeps its rules (all batches share four text slots; each batch at most `concurrency`). Round 4: at most
   * one image step per batch at a time (it submits up to image_concurrency images itself) and at most
   * storyboard_concurrency storyboard steps per batch; neither uses the extraction slots.
   */
  private slotFree(batch:BatchRow,step:StepRow,activeExtraction=this.runningCount(null,'extraction')){
    if(isExtraction(step.target))return activeExtraction<4&&this.runningCount(batch.id,'extraction')<batch.concurrency
    if(step.target==='images')return this.runningCount(batch.id,'images')<1
    return this.runningCount(batch.id,'storyboard')<(settings(batch).storyboard_concurrency??1)
  }
  async pump(){
    if(this.closed||this.pumping)return;this.pumping=true
    const skip=new Set<string>()
    try{for(;;){
      if(this.closed)break
      const activeExtraction=this.runningCount(null,'extraction')
      let candidate:{batch:BatchRow;step:StepRow}|undefined
      for(const batch of this.sql.prepare("SELECT * FROM platform_production_batches WHERE status='running' ORDER BY created_at,rowid").all() as BatchRow[]){
        this.refresh(batch.id);if(this.row(batch.id)?.status!=='running')continue
        // A step waits for the earlier steps of its episode; 拆分镜 only waits for 出图 to END (a failed image does not block it).
        const pending=this.sql.prepare(`SELECT s.* FROM platform_production_steps s WHERE s.batch_id=? AND s.status='queued'
          AND NOT EXISTS(SELECT 1 FROM platform_production_steps p WHERE p.batch_id=s.batch_id AND p.episode_id=s.episode_id AND p.order_index<s.order_index
            AND CASE WHEN s.target='storyboard' AND p.target='images' THEN p.status IN('queued','running') ELSE p.status!='completed' END) ORDER BY s.order_index`).all(batch.id) as StepRow[]
        for(const step of pending){const key=step.episode_id+':'+step.target
          if(skip.has(step.id)||!this.slotFree(batch,step,activeExtraction))continue
          if((this.busyUntil.get(key)||0)>Date.now()){this.later();continue}
          const conflict=this.sql.prepare("SELECT status FROM platform_production_steps WHERE episode_id=? AND target=? AND status IN('running','needs_review') AND id!=? ORDER BY CASE status WHEN 'needs_review' THEN 0 ELSE 1 END LIMIT 1").get(step.episode_id,step.target,step.id) as {status:string}|undefined
          // An image or storyboard step is safe to repeat, so only a RUNNING twin makes it wait.
          if(conflict&&!isExtraction(step.target)){if(conflict.status==='running'){this.busyUntil.set(key,Date.now()+5000);this.later();continue}}
          else if(conflict){if(conflict.status==='needs_review')this.finish(step,'needs_review','同集同类任务已有待核对记录，未重复提交。','prior_task_needs_review');continue}
          candidate={batch,step};break
        }
        if(candidate)break
      }
      if(!candidate)break
      const before=candidate.step.attempt
      await (isExtraction(candidate.step.target)?this.dispatch(candidate.batch,candidate.step):this.dispatchLong(candidate.batch,candidate.step))
      // A dispatch that started nothing (a race with pause, a busy twin) is not picked again in this round.
      const after=this.step(candidate.step.id);if(after?.status==='queued'&&after.attempt===before)skip.add(candidate.step.id)
    }}finally{this.pumping=false}
  }
  private async dispatch(batch:BatchRow,step:StepRow){
    let actor:Actor,choice:Choice
    const target=step.target as ExtractTarget
    try{
      const user=userById(batch.user_id);if(!user?.enabled)throw denied('任务发起用户已停用',401);actor=publicUser(user);assertProjectAccess(batch.drama_id,actor)
      const opts=settings(batch);choice=await this.resolve({config_id:batch.config_id,model:batch.model,model_parameters:opts.parameters},actor)
      const current=this.inputVersion(this.episode(step.episode_id,batch.drama_id),step.target,choice,this.version())
      if(current!==step.input_version){this.finish(step,'input_stale','剧本、文字配置或提取规范已变化，请确认后重试此步骤。','input_changed');return}
      if(opts.skip_completed){const receipt=this.receipt(step);if(receipt){this.useReceipt(step,receipt);this.refresh(batch.id);return}}
    }catch(error){this.finish(step,'failed',clean(error),'dispatch_rejected');return}
    const sameTypeRunning=this.deps.isExtractionRunning?this.deps.isExtractionRunning(step.episode_id,target):getExtractionStatus(step.episode_id)[target]?.status==='running'
    if(sameTypeRunning){this.busyUntil.set(step.episode_id+':'+step.target,Date.now()+1500);this.later();return}
    const attemptKey=randomUUID(),at=stamp()
    let activityId:string|null
    try{activityId=this.sql.transaction(()=>{
      assertProjectAccess(batch.drama_id,actor!)
      if(this.closed||this.row(batch.id)?.status!=='running'||this.step(step.id)?.status!=='queued')return null
      if(this.runningCount(null,'extraction')>=4||this.runningCount(batch.id,'extraction')>=batch.concurrency)return null
      if(this.sql.prepare("SELECT id FROM platform_production_steps WHERE episode_id=? AND target=? AND status='running'").get(step.episode_id,step.target))return null
      const taskId=createActivityTask({kind:'text',title:`批量提取${labels[step.target]} · 第${step.episode_number}集`,projectId:batch.drama_id,episodeId:step.episode_id,userId:batch.user_id,model:batch.model,
        request:{operation:'production_batch_extraction',batch_id:batch.id,step_id:step.id,target:step.target,config_id:batch.config_id,model:batch.model,input_version:step.input_version}})
      this.sql.prepare("UPDATE platform_production_steps SET status='running',attempt=attempt+1,attempt_key=?,activity_task_id=?,started_at=?,updated_at=?,error=NULL,error_code=NULL WHERE id=? AND status='queued'").run(attemptKey,taskId,at,at,step.id)
      return taskId
    }).immediate()}catch(error){this.finish(step,'failed',clean(error),'dispatch_rejected');return}
    if(!activityId)return
    const observed:any[]=[],onLifecycle=(event:ExtractionLifecycleEvent)=>{
      if(this.closed)return
      const fresh=this.step(step.id);if(!fresh||fresh.status!=='running'||fresh.attempt_key!==attemptKey)return
      if(event.phase==='step'){observed.push(event.step);return}
      if(event.phase==='done'){
        const receipt=extractionSaveReceipt(target,observed,event.result)
        if(!receipt.ok){this.finish(fresh,receipt.failed?'failed':'needs_review',receipt.error||'模型已返回，但未找到本类型成功保存工具的收据；未自动再次调用。',receipt.failed?'save_tool_failed':'missing_save_receipt',event.result);return}
        try{const current=this.inputVersion(this.episode(step.episode_id,batch.drama_id),step.target,choice,this.version());if(current!==fresh.input_version){this.finish(fresh,'input_stale','执行期间输入或提取规范发生变化，保存结果已保留，请确认后重试。','input_changed_during_execution',event.result);return}
          const completedAt=stamp();this.sql.transaction(()=>{
            this.sql.prepare(`INSERT INTO platform_production_receipts(episode_id,target,input_version,output_version,step_id,activity_task_id,receipt_json,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(episode_id,target,input_version) DO UPDATE SET output_version=excluded.output_version,step_id=excluded.step_id,activity_task_id=excluded.activity_task_id,receipt_json=excluded.receipt_json,created_at=excluded.created_at`).run(step.episode_id,step.target,fresh.input_version,this.outputVersion(step.episode_id,target),step.id,activityId,JSON.stringify(receipt),completedAt)
            this.sql.prepare("UPDATE platform_production_steps SET status='completed',receipt_json=?,updated_at=?,finished_at=?,error=NULL,error_code=NULL WHERE id=? AND status='running' AND attempt_key=?").run(JSON.stringify(receipt),completedAt,completedAt,step.id,attemptKey)
          }).immediate()
          try{updateActivityTask(activityId,{status:'completed',stage:'completed',output:{text:event.result?.text||'',toolCalls:event.result?.toolCalls||[],toolResults:event.result?.toolResults||[]},usage:event.result?.totalUsage||event.result?.usage,result:{batch_id:batch.id,step_id:step.id,receipt}})
          activityEvent(activityId,'completed','本类型原保存工具已完成，完成收据已保留。',{batch_id:batch.id,step_id:step.id,receipt})}catch{/* Diagnostics never repeat an accepted save. */}this.refresh(batch.id);this.kick()
        }catch(error){this.finish(fresh,'needs_review',clean(error),'receipt_persistence_failed',event.result)}
      }else if(event.phase==='error'){
        const message=clean(event.error),definite=[400,401,403,404,422,429].includes(event.providerHttpStatus||0)||/^(?:提取 Agent 不可用|未配置.*|.*无访问权限)$/u.test(message)
        this.finish(fresh,definite?'failed':'needs_review',message,definite?'extraction_failed':'extraction_result_unknown',undefined,
          event.providerHttpStatus?{provider_http_status:event.providerHttpStatus}:undefined)
      }
    }
    try{
      const accepted=runAsActor(actor!,()=>withActivityContext({taskId:activityId,projectId:batch.drama_id,episodeId:step.episode_id,userId:batch.user_id,title:`提取${labels[step.target]}`,textModelParameters:choice!.parameters},()=>this.starter(step.episode_id,batch.drama_id,target,{model:batch.model,configId:batch.config_id,onLifecycle})))
      if(!accepted){
        this.sql.prepare("UPDATE platform_production_steps SET status='queued',attempt=attempt-1,attempt_key=NULL,activity_task_id=NULL,started_at=NULL,updated_at=? WHERE id=? AND status='running' AND attempt_key=?").run(stamp(),step.id,attemptKey)
        // The original in-memory same-episode lock owns that request; do not poll it as this attempt.
        // No operation was started. Remove only this just-created, unsubmitted diagnostic placeholder.
        this.sql.prepare('DELETE FROM platform_activity_events WHERE task_id=?').run(activityId)
        this.sql.prepare('DELETE FROM platform_activity_tasks WHERE id=? AND NOT EXISTS(SELECT 1 FROM platform_activity_rounds WHERE task_id=?)').run(activityId,activityId)
        this.busyUntil.set(step.episode_id+':'+step.target,Date.now()+1500);this.later()
      }
    }catch(error){this.finish(this.step(step.id)!,'needs_review',clean(error),'start_result_unknown')}
  }
  /** Round 4: start an image or storyboard step; the work itself runs in runImages / runStoryboard. */
  private async dispatchLong(batch:BatchRow,step:StepRow){
    let actor:Actor,choice:Choice
    try{
      const user=userById(batch.user_id);if(!user?.enabled)throw denied('任务发起用户已停用',401);actor=publicUser(user);assertProjectAccess(batch.drama_id,actor)
      const opts=settings(batch);choice=await this.resolve({config_id:batch.config_id,model:batch.model,model_parameters:opts.parameters},actor)
      this.episode(step.episode_id,batch.drama_id)
    }catch(error){this.finish(step,'failed',clean(error),'dispatch_rejected');return}
    const attemptKey=randomUUID(),at=stamp()
    let activityId:string|null
    try{activityId=this.sql.transaction(()=>{
      assertProjectAccess(batch.drama_id,actor!)
      if(this.closed||this.row(batch.id)?.status!=='running'||this.step(step.id)?.status!=='queued'||!this.slotFree(batch,step))return null
      if(this.sql.prepare("SELECT id FROM platform_production_steps WHERE episode_id=? AND target=? AND status='running'").get(step.episode_id,step.target))return null
      // The storyboard job keeps its own activity record; the image step records the batch's own coordination task.
      const taskId=step.target==='images'?createActivityTask({kind:'image',title:`批量出图 · 第${step.episode_number}集`,projectId:batch.drama_id,episodeId:step.episode_id,userId:batch.user_id,
        request:{operation:'production_batch_images',batch_id:batch.id,step_id:step.id}}):null
      this.sql.prepare("UPDATE platform_production_steps SET status='running',attempt=attempt+1,attempt_key=?,activity_task_id=?,started_at=?,updated_at=?,error=NULL,error_code=NULL,receipt_json=NULL WHERE id=? AND status='queued'").run(attemptKey,taskId,at,at,step.id)
      return taskId??''
    }).immediate()}catch(error){this.finish(step,'failed',clean(error),'dispatch_rejected');return}
    if(activityId===null)return
    const run=(step.target==='images'?this.runImages(batch,step,actor!,attemptKey,activityId||null):this.runStoryboard(batch,step,actor!,choice!,attemptKey))
      .catch(error=>{const fresh=this.step(step.id);if(fresh?.attempt_key===attemptKey&&fresh.status==='running')this.finish(fresh,'needs_review',clean(error),'step_result_unknown')})
      .finally(()=>{this.runs.delete(attemptKey);this.kick()})
    this.runs.set(attemptKey,run)
  }
  private sleep(ms:number){return new Promise<void>(resolve=>{const timer=setTimeout(resolve,ms);timer.unref?.()})}
  /** The step is still this attempt and the batch was not closed (a restart or a newer attempt ends this run). */
  private current(step:StepRow,attemptKey:string){if(this.closed)return null;const fresh=this.step(step.id);return fresh?.status==='running'&&fresh.attempt_key===attemptKey?fresh:null}
  private saveResult(step:StepRow,attemptKey:string,result:ImagesStepResult|StoryboardStepResult){this.sql.prepare("UPDATE platform_production_steps SET receipt_json=?,updated_at=? WHERE id=? AND status='running' AND attempt_key=?").run(JSON.stringify(result),stamp(),step.id,attemptKey)}
  private complete(step:StepRow,attemptKey:string,result:ImagesStepResult|StoryboardStepResult,note?:{error:string;code:string}){
    const at=stamp()
    this.sql.prepare("UPDATE platform_production_steps SET status='completed',receipt_json=?,error=?,error_code=?,updated_at=?,finished_at=? WHERE id=? AND status='running' AND attempt_key=?")
      .run(JSON.stringify(result),note?.error??null,note?.code??null,at,at,step.id,attemptKey)
    this.refresh(step.batch_id);this.kick()
  }
  /** Assets linked to the episode that can be drawn (a narrator is a voice and is never drawn). */
  private episodeAssets(episodeId:number){
    const rows:{kind:AssetKind;id:number;name:string;image_url:string|null}[]=[]
    for(const [kind,table,link,column,label] of [['character','characters','episode_characters','character_id','name'],['scene','scenes','episode_scenes','scene_id','location'],['prop','props','episode_props','prop_id','name']] as const){
      for(const row of this.sql.prepare(`SELECT t.id,t.${label} AS name,t.image_url,${kind==='character'?'t.role':'NULL AS role'} FROM ${table} t WHERE t.deleted_at IS NULL AND t.id IN (SELECT ${column} FROM ${link} WHERE episode_id=?) ORDER BY t.id`).all(episodeId) as any[]){
        if(kind==='character'&&narrator(row))continue
        rows.push({kind,id:row.id,name:String(row.name||'#'+row.id),image_url:row.image_url||null})
      }
    }
    return rows
  }
  /** An image job (preparation or generation) already running for this asset, from any page or batch. */
  private activeImage(kind:AssetKind,id:number,styleSnapshot:StyleSnapshot|null):ImageSubmission|null{
    const field=kind==='character'?'character_id':kind==='scene'?'scene_id':'prop_id'
    const job=this.sql.prepare(`SELECT j.id,j.image_generation_id,j.request_json,t.params FROM platform_asset_image_jobs j LEFT JOIN sys_task t ON t.id=j.image_generation_id
      WHERE j.asset_kind=? AND j.asset_id=? AND (j.status='preparing_prompt' OR t.status IN('processing','pending')) ORDER BY j.created_at DESC LIMIT 1`).get(kind,id) as any
    const conflict={error:'该素材已有不同风格版本的图片任务，请核对原任务；本批次未重复提交。',status:409,errorCode:'image_style_conflict'}
    const snapshot=(text:string|undefined)=>{try{const value=JSON.parse(text||'{}');return Object.hasOwn(value,'styleSnapshot')?value.styleSnapshot:undefined}catch{return undefined}}
    if(job){const actual=snapshot(job.params),prepared=snapshot(job.request_json);return conflictingStyleSnapshots(styleSnapshot,actual===undefined?prepared:actual)?conflict:{assetJobId:job.id,imageGenerationId:job.image_generation_id}}
    const task=this.sql.prepare(`SELECT id,params FROM sys_task WHERE type='image' AND ${field}=? AND status IN('processing','pending') ORDER BY id DESC LIMIT 1`).get(id) as any
    return task?conflictingStyleSnapshots(styleSnapshot,snapshot(task.params))?conflict:{imageGenerationId:task.id}:null
  }
  /**
   * Round 4 出图: every drawable asset of the episode without an image gets one image through the normal entry point.
   * At most image_concurrency images of this step are in flight, submissions are spaced, and a temporary relay error
   * (429, 5xx, prompt-preparation hiccup) is retried after 15 s and then 45 s. Authentication, permission, content refusal or
   * any other definite error is reported per asset and does not stop the other assets or the storyboard.
   */
  private async runImages(batch:BatchRow,step:StepRow,actor:Actor,attemptKey:string,activityId:string|null){
    // The preparation table is created by its own service; make sure it exists before it is read here.
    initAssetImagePreparation()
    const opts=settings(batch),styleSnapshot=this.frozenStyle(batch),limit=Math.max(1,Math.min(4,opts.image_concurrency??3)),delays=this.deps.retryDelaysMs??[15_000,45_000]
    const poll=this.deps.pollMs??4000,gap=this.deps.submitGapMs??2000,maxWait=this.deps.imageWaitMs??15*60_000
    const assets=this.episodeAssets(step.episode_id),needed=assets.filter(asset=>!asset.image_url)
    const result:ImagesStepResult={kind:'images',total:assets.length,needed:needed.length,generated:0,skipped_existing:assets.length-needed.length,running:true,failed:[]}
    this.saveResult(step,attemptKey,result)
    if(activityId)activityEvent(activityId,'running',`本集共${assets.length}个可出图素材，${needed.length}个还没有图片。`,{batch_id:batch.id,step_id:step.id})
    type Slot={asset:typeof needed[number];attempt:number;submission:ImageSubmission;startedAt:number}
    const queue=needed.map(asset=>({asset,attempt:0,notBefore:0})),active:Slot[]=[]
    let lastSubmit=0
    const body={episode_id:step.episode_id,...(opts.image_config_id?{config_id:opts.image_config_id,model:opts.image_model||undefined}:{}),text_model:batch.model,text_config_id:batch.config_id,text_model_parameters:opts.parameters}
    const settle=(slot:Slot,outcome:ImageOutcome)=>{
      if(outcome.state==='done'){result.generated++;return}
      const code=outcome.code||'generation_failed',limitFor=imageRetryLimits[code]??1
      if(slot.attempt+1<limitFor){queue.push({asset:slot.asset,attempt:slot.attempt+1,notBefore:Date.now()+(delays[Math.min(slot.attempt,delays.length-1)]??15_000)});return}
      result.failed.push({asset_kind:slot.asset.kind,asset_id:slot.asset.id,name:slot.asset.name,error_code:code,error:clean(outcome.message||'图片未生成')})
    }
    while(queue.length||active.length){
      if(!this.current(step,attemptKey))return
      for(const slot of [...active]){
        const outcome=this.imageOutcome(slot.asset.kind,slot.asset.id,slot.submission)
        const timedOut=outcome.state==='pending'&&Date.now()-slot.startedAt>maxWait
        if(outcome.state==='pending'&&!timedOut)continue
        active.splice(active.indexOf(slot),1)
        settle(slot,timedOut?{state:'failed',code:'image_wait_timeout',message:'等待图片超过上限，未自动重新提交；可稍后在剧集页查看或重试'}:outcome)
      }
      // A paused batch keeps watching what is already submitted but submits nothing new.
      const paused=this.row(batch.id)?.status!=='running'
      while(!paused&&active.length<limit&&queue.length){
        const index=queue.findIndex(item=>item.notBefore<=Date.now());if(index<0)break
        if(Date.now()-lastSubmit<gap)break
        const item=queue.splice(index,1)[0]
        const table=item.asset.kind==='character'?'characters':item.asset.kind==='scene'?'scenes':'props'
        const fresh=this.sql.prepare(`SELECT image_url,deleted_at FROM ${table} WHERE id=?`).get(item.asset.id) as any
        if(!fresh||fresh.deleted_at){result.needed--;continue}
        if(fresh.image_url){result.skipped_existing++;result.needed--;continue}
        // Shared with another episode or started on the episode page: follow that job instead of submitting a second one.
        const existing=this.activeImage(item.asset.kind,item.asset.id,styleSnapshot)
        const submission=existing??await runAsActor(actor,()=>withActivityContext({projectId:batch.drama_id,episodeId:step.episode_id,userId:batch.user_id,styleSnapshot},()=>this.submitImage(item.asset.kind,item.asset.id,body)))
        if(this.closed)return
        lastSubmit=Date.now()
        if(submission.error){if(submission.errorCode==='image_style_conflict'){this.finish(step,'needs_review',submission.error,'image_style_conflict',result);return}settle({asset:item.asset,attempt:item.attempt,submission,startedAt:Date.now()},{state:'failed',code:submission.status===409?'image_already_running':'image_submit_rejected',message:submission.error});continue}
        active.push({asset:item.asset,attempt:item.attempt,submission,startedAt:Date.now()})
      }
      this.saveResult(step,attemptKey,result)
      if(!queue.length&&!active.length)break
      await this.sleep(poll)
    }
    if(!this.current(step,attemptKey))return
    result.running=false
    const failed=result.failed.length
    if(activityId){
      updateActivityTask(activityId,{status:failed?'failed':'completed',stage:failed?'completed_with_errors':'completed',result:{batch_id:batch.id,step_id:step.id,...result}})
      activityEvent(activityId,failed?'failed':'completed',failed?`本集出图完成，${result.generated}张成功，${failed}张未生成。`:`本集出图完成，新生成${result.generated}张。`,{batch_id:batch.id,step_id:step.id})
    }
    if(failed&&!result.generated&&result.needed)this.failLong(step,attemptKey,result,`本集${failed}张图片都未生成：${result.failed[0].error}`,'images_failed')
    else this.complete(step,attemptKey,result,failed?{error:`${failed}张图片未生成，其余已完成；可在剧集页单独重试。`,code:'images_partial'}:undefined)
  }
  private failLong(step:StepRow,attemptKey:string,result:ImagesStepResult|StoryboardStepResult,message:string,code:string){
    const at=stamp();this.sql.prepare("UPDATE platform_production_steps SET status='failed',receipt_json=?,error=?,error_code=?,updated_at=?,finished_at=? WHERE id=? AND status='running' AND attempt_key=?").run(JSON.stringify(result),clean(message),code,at,at,step.id,attemptKey)
    this.refresh(step.batch_id);this.kick()
  }
  /**
   * Round 4 拆分镜: the same job the episode page's 拆分分镜 button starts (it continues by itself up to two more rounds).
   * done → completed; needs_revision → completed with a note (the draft and finished groups are kept for the user);
   * error → failed. An already running storyboard job of the same episode is followed, never duplicated.
   */
  private async runStoryboard(batch:BatchRow,step:StepRow,actor:Actor,choice:Choice,attemptKey:string){
    const poll=this.deps.pollMs??5000
    const storyboards=(this.sql.prepare('SELECT count(*) n FROM storyboards WHERE episode_id=? AND deleted_at IS NULL').get(step.episode_id) as any).n as number
    if(storyboards>0){this.complete(step,attemptKey,{kind:'storyboard',skipped:true},{error:'本集已有分镜，未重新拆分；需要重拆请在剧集页操作。',code:'storyboard_exists'});return}
    const started=await runAsActor(actor,()=>withActivityContext({projectId:batch.drama_id,episodeId:step.episode_id,userId:batch.user_id,textModelParameters:choice.parameters,styleSnapshot:this.frozenStyle(batch)},
      ()=>this.beginStoryboard({agentType:'storyboard_breaker',episodeId:step.episode_id,dramaId:batch.drama_id,message:storyboardBreakdownMessage(step.episode_id,this.sql),model:batch.model,configId:batch.config_id})))
    if(this.closed)return
    const jobId=started.job_id
    const activity=activitySource('agent_jobs',jobId)
    if(activity?.id)this.sql.prepare("UPDATE platform_production_steps SET activity_task_id=? WHERE id=? AND attempt_key=?").run(activity.id,step.id,attemptKey)
    this.saveResult(step,attemptKey,{kind:'storyboard',job_id:jobId})
    for(;;){
      if(!this.current(step,attemptKey))return
      const job=await this.storyboardJob(jobId)
      if(this.closed)return
      if(!job){this.finish(this.step(step.id)!,'needs_review','分镜任务记录不存在，未自动重新提交。','storyboard_job_missing');return}
      const progress:StoryboardStepResult={kind:'storyboard',job_id:jobId,draft_id:job.draft_id,completed:job.completed,total:job.total}
      if(job.status==='running'){this.saveResult(step,attemptKey,progress);await this.sleep(poll);continue}
      if(!this.current(step,attemptKey))return
      if(job.status==='done'){this.complete(step,attemptKey,progress);return}
      if(job.status==='needs_revision'){this.complete(step,attemptKey,progress,{error:`分镜已自动续跑仍有${Math.max(0,(job.total||0)-(job.completed||0))}组未通过，草稿已保留，请到剧集页查看原因。`,code:'storyboard_needs_revision'});return}
      this.failLong(step,attemptKey,progress,job.error||'分镜任务未完成','storyboard_failed');return
    }
  }
  private finish(step:StepRow,status:'failed'|'input_stale'|'needs_review',message:string,code:string,result?:any,diagnostics?:{provider_http_status?:number}){
    const at=stamp();const changed=this.sql.prepare("UPDATE platform_production_steps SET status=?,error=?,error_code=?,updated_at=?,finished_at=? WHERE id=? AND status IN('queued','running')").run(status,clean(message),code,at,at,step.id)
    if(!changed.changes)return
    if(step.activity_task_id){updateActivityTask(step.activity_task_id,{status:status==='needs_review'?'interrupted':'failed',stage:status,error:clean(message),result:{batch_id:step.batch_id,step_id:step.id,...diagnostics},...(result?{output:{text:result.text||'',toolCalls:result.toolCalls||[],toolResults:result.toolResults||[]},usage:result.totalUsage||result.usage}:{})});activityEvent(step.activity_task_id,status,clean(message),{error_code:code,batch_id:step.batch_id,step_id:step.id,...diagnostics})}
    this.refresh(step.batch_id);this.kick()
  }
  close(){this.closed=true;if(this.wake)clearTimeout(this.wake)}
  /** Tests: wait for the image/storyboard runs this manager started. */
  async settle(){while(this.runs.size)await Promise.allSettled([...this.runs.values()])}
}

let manager:ProductionBatchManager|undefined
export function initProductionBatches(){return manager??=new ProductionBatchManager()}
export const createProductionBatch=(input:CreateProductionBatch,actor?:Actor)=>initProductionBatches().create(input,actor)
export const getProductionBatch=(id:string,actor?:Actor)=>initProductionBatches().get(id,actor)
export const listProductionBatches=(filters:{dramaId?:number;limit?:number}={},actor?:Actor)=>initProductionBatches().list(filters,actor)
export const readProductionDashboardSteps=(projectIds:number[],actor?:Actor)=>initProductionBatches().dashboard(projectIds,actor)
export const pauseProductionBatch=(id:string,actor?:Actor)=>initProductionBatches().pause(id,actor)
export const resumeProductionBatch=(id:string,actor?:Actor)=>initProductionBatches().resume(id,actor)
export const retryProductionBatch=(id:string,stepIds?:string[],actor?:Actor)=>initProductionBatches().retry(id,stepIds,actor)
export const recoverProductionBatches=()=>initProductionBatches().recoverInterrupted()
export const startProductionBatchScheduler=()=>initProductionBatches().pump()
