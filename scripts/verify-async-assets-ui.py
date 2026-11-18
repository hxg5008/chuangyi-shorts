"""Eight deliberately slow prompt jobs through the real UI/backend and local fake models only."""
import argparse,binascii,http.server,json,pathlib,re,struct,threading,time,uuid,zlib
from playwright.sync_api import sync_playwright,expect

parser=argparse.ArgumentParser();parser.add_argument('--test-root',required=True);parser.add_argument('--artifacts',required=True);args=parser.parse_args()
root=pathlib.Path(args.test_root).resolve();assert root.name.startswith('huobao-platform-registration-')
artifacts=pathlib.Path(args.artifacts).resolve();artifacts.mkdir(parents=True,exist_ok=True)
url='http://127.0.0.1:15679';suffix=uuid.uuid4().hex[:7];release=threading.Event();checks=[];errors=[];prompt_ids=[];image_calls=[];lock=threading.Lock()
initial=root/'admin-initial-password.txt';password=re.search(r'^Initial password: (.+)$',initial.read_text('utf-8'),re.M).group(1).strip() if initial.exists() else '1'
def png():
 def chunk(name,data):return struct.pack('!I',len(data))+name+data+struct.pack('!I',binascii.crc32(name+data)&0xffffffff)
 return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('!IIBBBBB',256,144,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(b''.join(b'\x00'+bytes((65,135,199))*256 for _ in range(144))))+chunk(b'IEND',b'')
image=png();fail_id=None
class Mock(http.server.BaseHTTPRequestHandler):
 protocol_version='HTTP/1.1'
 def log_message(self,*_):pass
 def send_json(self,value,status=200):
  data=json.dumps(value,ensure_ascii=False).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.send_header('Connection','close');self.end_headers();self.wfile.write(data)
 def do_GET(self):
  if self.path=='/synthetic.png':self.send_response(200);self.send_header('Content-Type','image/png');self.send_header('Content-Length',str(len(image)));self.send_header('Connection','close');self.end_headers();self.wfile.write(image)
  else:self.send_json({'error':'Synthetic route not configured'},404)
 def do_POST(self):
  body=json.loads(self.rfile.read(int(self.headers.get('Content-Length','0'))))
  if self.path.endswith('/images/generations'):
   failed='失败准备-' in body.get('prompt','')
   with lock:image_calls.append({'model':body.get('model'),'prompt':body.get('prompt'),'failed':failed})
   if failed:return self.send_json({'error':{'message':'SYNTHETIC_IMAGE_FAILURE'}},400)
   return self.send_json({'data':[{'url':mock_url+'/synthetic.png'}]})
  if not self.path.endswith('/chat/completions'):return self.send_json({'error':'Unexpected synthetic model route'},400)
  messages=body.get('messages',[]);tool_result=any(message.get('role')=='tool' for message in messages)
  match=re.search(r'character_id=(\d+)',json.dumps(messages,ensure_ascii=False))
  if not match:return self.send_json({'error':{'message':'Synthetic prompt fixture did not identify its character'}},400)
  character_id=int(match.group(1))
  if not tool_result:
   with lock:prompt_ids.append(character_id)
   release.wait(60)
   if character_id==fail_id:return self.send_json({'error':{'message':'SYNTHETIC_PREPARATION_FAILURE'}},400)
   tool=next((item.get('function',{}).get('name') for item in body.get('tools',[]) if item.get('function',{}).get('name','').endswith('save_character_final_prompt')),None)
   if not tool:return self.send_json({'error':{'message':'Expected original save-character-prompt tool was not supplied'}},400)
   delta={'role':'assistant','tool_calls':[{'index':0,'id':'save-'+str(character_id),'type':'function','function':{'name':tool,'arguments':json.dumps({'character_id':character_id,'prompt':'SYNTHETIC_ASSET_PROMPT_'+str(character_id)+'，白底角色三视图，真实测试素材。'},ensure_ascii=False)}}]};finish='tool_calls'
  else:delta={'role':'assistant','content':'已保存。'};finish='stop'
  if not body.get('stream'):
   message={'role':'assistant',**({'content':'已保存。'} if tool_result else {'content':None,'tool_calls':[{k:v for k,v in delta['tool_calls'][0].items() if k!='index'}]})}
   return self.send_json({'id':'synthetic','object':'chat.completion','model':body.get('model'),'choices':[{'index':0,'message':message,'finish_reason':finish}],'usage':{'prompt_tokens':20,'completion_tokens':10,'total_tokens':30}})
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Connection','close');self.end_headers()
  try:
   first={'id':'synthetic','object':'chat.completion.chunk','created':int(time.time()),'model':body.get('model'),'choices':[{'index':0,'delta':delta,'finish_reason':None}]}
   last={'id':'synthetic','object':'chat.completion.chunk','created':int(time.time()),'model':body.get('model'),'choices':[{'index':0,'delta':{},'finish_reason':finish}],'usage':{'prompt_tokens':20,'completion_tokens':10,'total_tokens':30}}
   self.wfile.write(('data: '+json.dumps(first,ensure_ascii=False)+'\n\ndata: '+json.dumps(last)+'\n\ndata: [DONE]\n\n').encode());self.wfile.flush()
  except (BrokenPipeError,ConnectionResetError):pass
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Mock);mock_url='http://127.0.0.1:'+str(server.server_port);threading.Thread(target=server.serve_forever,daemon=True).start()
def api(context,method,path,body=None):
 identity=context.request.get(url+'/api/v1/auth/me').json()['data'];response=context.request.fetch(url+'/api/v1'+path,method=method,data=body,headers={'X-CSRF-Token':identity['csrfToken']});value=response.json();assert response.ok and value.get('code',200)<400,(path,response.status,value.get('message'));return value.get('data',value)
def check(label):checks.append(label)
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path=r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',headless=True)
  context=browser.new_context(viewport={'width':1540,'height':1080},locale='zh-CN');context.add_init_script("for(let id=1;id<200;id++)localStorage.setItem(`huobao:user:${id}:huobao:tours`,JSON.stringify(['index','detail','episode']));")
  page=context.new_page();page.on('pageerror',lambda error:errors.append(str(error)))
  page.goto(url+'/login');page.get_by_label('用户名',exact=True).fill('admin');page.get_by_label('密码',exact=True).fill(password);page.get_by_role('button',name='进入工作台',exact=True).click();page.wait_for_url(url+'/')
  channel=api(context,'POST','/admin/channels',{'name':'Slow local '+suffix,'base_url':mock_url,'api_key':'synthetic-only-key','enabled':True})
  text=api(context,'POST',f'/admin/channels/{channel["id"]}/models',{'name':'Slow text '+suffix,'model':'ui-slow-text-'+suffix,'type':'text','protocol_id':'text.openai-chat','enabled':True,'access':'all','priority':1000000})
  picture=api(context,'POST',f'/admin/channels/{channel["id"]}/models',{'name':'Local image '+suffix,'model':'ui-local-image-'+suffix,'type':'image','protocol_id':'image.openai','enabled':True,'access':'all','priority':1000000})
  video=api(context,'POST',f'/admin/channels/{channel["id"]}/models',{'name':'Unused video fixture','model':'ui-unused-video-'+suffix,'type':'video','protocol_id':'video.minimax','enabled':True,'access':'all','priority':1000000})
  project=api(context,'POST','/dramas',{'title':'Async eight '+suffix,'style':'','aspect_ratio':'16:9'})
  episode=api(context,'POST','/episodes',{'drama_id':project['id'],'title':'慢提示词测试','image_config_id':picture['config_id'],'video_config_id':video['config_id']})
  api(context,'PUT',f'/episodes/{episode["id"]}',{'script_content':'第一集\n## S01 | 内景·测试室 | 白天\n八位角色依次整理工作台。'})
  characters=[]
  for index in range(8):characters.append(api(context,'POST','/characters',{'drama_id':project['id'],'episode_id':episode['id'],'name':('失败准备' if index==7 else '慢提示词'+str(index+1))+'-'+suffix,'appearance':'独立测试角色','styling':'日常测试服装'}))
  fail_id=characters[-1]['id'];responses=[];prompt_posts=[]
  page.on('response',lambda response:responses.append(response) if response.request.method=='POST' and response.url.endswith('/generate-image') else None)
  page.on('request',lambda request:prompt_posts.append(request.url) if request.method=='POST' and request.url.endswith('/generate-prompt') else None)
  page.goto(url+f'/drama/{project["id"]}/episode/{episode["episode_number"]}');page.locator('.pipeline button').filter(has_text='资产制作').click()
  # Earlier isolated runs keep their history/configuration. Select this run's live
  # synthetic text binding explicitly rather than relying on equal-priority defaults.
  text_select=page.locator('.studio-model-picks .model-select').filter(has=page.locator('.model-select-label').get_by_text('文本',exact=True))
  text_select.locator('.model-select-trigger').click()
  page.get_by_role('menuitem').filter(has_text='Slow text '+suffix).click()
  page.evaluate("id=>{window.probeEvents=new EventSource('/api/v1/activity/events?drama_id='+id);return true}",project['id']);page.wait_for_function('window.probeEvents.readyState===1')
  started=time.monotonic();page.get_by_role('button',name='批量角色',exact=True).click()
  expect(page.locator('.asset-preparation-notice')).to_contain_text('8 项',timeout=15000)
  accepted_seconds=time.monotonic()-started
  assert len(responses)==8 and all(response.status==202 for response in responses)
  assert all(response.json()['data'].get('asset_job_id') for response in responses)
  assert len(prompt_posts)==0,'The browser must not send a second long synchronous generate-prompt request.'
  deadline=time.time()+15
  while time.time()<deadline and len(set(prompt_ids))<8:page.wait_for_timeout(80)
  assert len(set(prompt_ids))==8,{'prompt_requests':prompt_ids}
  assert len(image_calls)==0,'Images must wait until their own prompt is saved.'
  probe=page.evaluate("async id=>{const start=performance.now(),r=await fetch('/api/v1/asset-image-jobs?episode_id='+id),j=await r.json();return{ms:performance.now()-start,status:r.status,count:j.data.items.length}}",episode['id'])
  assert probe['status']==200 and probe['count']==8 and probe['ms']<2500,probe
  assert accepted_seconds<10,'The batch must return short job acknowledgements before the delayed prompt finishes.'
  check('eight slow prompts are accepted with HTTP202, no duplicate synchronous prompt POST, while an actual same-origin SSE connection and job GET remain responsive')
  page.locator('.pipeline button').filter(has_text='原始内容').click();expect(page.locator('.fill-textarea')).to_be_visible();page.locator('.pipeline button').filter(has_text='资产制作').click()
  expect(page.locator('.asset-preparation-notice')).to_contain_text('8 项')
  page.reload();expect(page.locator('.asset-preparation-notice')).to_contain_text('8 项',timeout=12000)
  assert len(responses)==8 and len(set(prompt_ids))==8
  page.screenshot(path=str(artifacts/'01-eight-preparing-responsive.png'),full_page=True)
  check('the user can switch panels and refresh while preparation continues; persisted jobs restore without resubmission')
  release.set();deadline=time.time()+60
  while time.time()<deadline:
   jobs=api(context,'GET',f'/asset-image-jobs?episode_id={episode["id"]}')['items'];tasks=api(context,'GET',f'/tasks?type=image&drama_id={project["id"]}')
   if len(jobs)==8 and all(job['status']=='completed' for job in jobs) and len(tasks)==8 and all(task['status'] in ['completed','failed'] for task in tasks):break
   page.wait_for_timeout(200)
  assert len(jobs)==8 and all(job['status']=='completed' and job['image_generation_id'] for job in jobs),jobs
  assert len(tasks)==8 and sum(task['status']=='completed' for task in tasks)==7 and sum(task['status']=='failed' for task in tasks)==1,[(task['id'],task['status'],task.get('errorMsg')) for task in tasks]
  expect(page.locator('.character-gen-btn:disabled')).to_have_count(0,timeout=12000)
  assert len(image_calls)==8 and len(set(prompt_ids))==8 and prompt_ids.count(fail_id)==1
  assert sum(item['failed'] for item in image_calls)==1
  assert sum('失败准备-'+suffix in item['prompt'] for item in image_calls)==1,'The unchanged legacy fallback prompt must be submitted once, not suppressed or retried.'
  page.wait_for_timeout(2800)
  assert len(responses)==8 and len(image_calls)==8 and len(prompt_posts)==0
  page.locator('.task-center-launcher').click();page.locator('.activity-item').filter(has_text='图片生成 · 失败准备-'+suffix).click()
  expect(page.locator('.activity-failure')).to_contain_text(re.compile(r'HTTP\s*400'))
  expect(page.locator('.activity-status-chip')).to_contain_text('失败')
  page.screenshot(path=str(artifacts/'02-seven-complete-one-failed.png'),full_page=True)
  check('legacy text-error fallback is preserved exactly once; seven image tasks complete and one real image HTTP400 releases its card with visible logs, without automatic retries')
  page.goto(url+f'/drama/{project["id"]}');page.locator('.page-tabs button').filter(has_text='素材库').click();expect(page.locator('.character-gen-btn')).to_have_count(8)
  expect(page.locator('.character-gen-btn:disabled')).to_have_count(0)
  project_data=api(context,'GET',f'/dramas/{project["id"]}')
  assert sum(bool(character.get('image_url') or character.get('imageUrl')) for character in project_data['characters'])==7
  page.screenshot(path=str(artifacts/'03-project-restored-state.png'),full_page=True)
  check('project material entry reads the same persistent preparation/image states and remains ready after terminal results')
  assert not errors,errors
  browser.close()
 result={'passed':len(checks),'checks':checks,'page_errors':errors,'paid_requests':0,'localhost_upstream':mock_url,'short_acknowledgement_seconds':round(accepted_seconds,3),'status_probe':probe,'browser_generate_image_posts':len(responses),'browser_generate_prompt_posts':len(prompt_posts),'unique_slow_prompt_jobs':len(set(prompt_ids)),'image_generations':len(image_calls),'failed_images':1,'legacy_text_failure_fallback_requests':1,'project_id':project['id']}
 (artifacts/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),'utf-8');print(json.dumps({'passed':len(checks),'page_errors':len(errors),'paid_requests':0,'short_acknowledgement_seconds':round(accepted_seconds,3),'status_get_ms':round(probe['ms']),'artifacts':str(artifacts)},ensure_ascii=False))
except Exception:
 (artifacts/'failure-context.json').write_text(json.dumps({'checks':checks,'page_errors':errors,'slow_prompt_ids':prompt_ids,'image_generations':len(image_calls),'paid_requests':0},ensure_ascii=False,indent=2),'utf-8');raise
finally:release.set();server.shutdown();server.server_close()
