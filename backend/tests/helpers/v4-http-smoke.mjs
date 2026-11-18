/** Real HTTP smoke against the disposable v4-ui-fixture only; no model calls. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
const base='http://127.0.0.1:15728',checks=[]
let cookie='',csrf=''
async function request(method,path,body,allowed=200){
 const response=await fetch(base+'/api/v1'+path,{method,headers:{Origin:base,...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})})
 const set=response.headers.get('set-cookie');if(set)cookie=set.split(';')[0]
 const value=await response.json();assert.equal(response.status,allowed,`${method} ${path}: ${JSON.stringify(value)}`);return value.data??value
}
const logged=await request('POST','/auth/login',{username:'ui-operator',password:'local-ui-test'});csrf=logged.csrfToken
assert.ok(csrf);checks.push('isolated_admin_login')
const list=await request('GET','/dramas');const project=list.items.find(item=>item.title.includes('界面验收'));assert.ok(project)
const before=await request('GET',`/dramas/${project.id}`);const start=Math.max(0,...before.episodes.map(ep=>Number(ep.episode_number)))
const styles=await request('GET','/style-presets');assert.ok(styles.length>=189);assert.equal(styles.filter(item=>item.source==='xyq').length,132);checks.push('style_catalog_count_and_categories')
const covered=styles.find(item=>item.source==='xyq'&&item.cover);const cover=await fetch(base+covered.cover);assert.equal(cover.status,200);assert.ok((await cover.arrayBuffer()).byteLength>100);checks.push('packaged_cover_served')
const raw='第10集开端\r\n## S01 | 内景 | 房间 | 夜\r\n小李：PS，我没有说免费阅读。\r\n\r\n第11集转折\r\n## S02 | 外景 | 门口 | 日\r\n小李：首发是原文，不能删。\r\n批次记录：'+Date.now()
const preview=await request('POST',`/dramas/${project.id}/imports/preview`,{kind:'script',filename:'示例完整剧本.txt',file_base64:Buffer.from(raw).toString('base64')});assert.equal(preview.sections.length,2)
const input={sections:preview.sections.map((part,i)=>({...part,episode_number:start+i+1}))}
const receipt=await request('POST',`/dramas/${project.id}/imports/${preview.id}/commit`,input)
const replay=await request('POST',`/dramas/${project.id}/imports/${preview.id}/commit`,input);assert.equal(replay.replayed,true);assert.deepEqual(receipt.episodes,replay.episodes);checks.push('real_http_atomic_import_idempotent_replay')
const detail=await request('GET',`/dramas/${project.id}`);assert.equal(detail.episodes.length,before.episodes.length+2);assert.ok(detail.episodes.every(ep=>ep.script_content===ep.content));assert.ok(detail.episodes[0].content.includes('免费阅读'));checks.push('finished_script_content_preserved')
const source=await fetch(base+`/api/v1/dramas/${project.id}/imports/${preview.id}/source`,{headers:{Cookie:cookie}});assert.equal(source.status,200);assert.equal(Buffer.from(await source.arrayBuffer()).toString(),raw);checks.push('source_download_exact_bytes')
for(const route of ['/admin/execution','/drama/'+project.id,'/settings']){const page=await fetch(base+route);assert.equal(page.status,200);assert.match(await page.text(),/<!doctype html>/iu)}checks.push('built_frontend_routes_served')
const added=await request('POST','/auth/register',{username:'http-smoke-'+Date.now(),password:'test-only'});csrf=added.csrfToken
await request('GET',`/dramas/${project.id}/imports`,undefined,404)
await request('GET','/admin/execution/services/1',undefined,403);checks.push('another_user_cannot_read_source_or_admin_configuration')
console.log(JSON.stringify({checks,passed:checks.length,modelRequests:0,browserVisualInspection:false},null,2))
if(process.env.CY_SMOKE_RECEIPT)fs.writeFileSync(process.env.CY_SMOKE_RECEIPT,JSON.stringify({checks,passed:checks.length,modelRequests:0,browserVisualInspection:false},null,2))
