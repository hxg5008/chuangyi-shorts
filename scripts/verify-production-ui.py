"""Real batch/dashboard HTTP and UI against an isolated app and a localhost model only."""
import argparse,http.server,json,pathlib,re,threading,time,uuid
from playwright.sync_api import sync_playwright,expect
parser=argparse.ArgumentParser();parser.add_argument('--url',default='http://127.0.0.1:15689');parser.add_argument('--test-root',required=True);parser.add_argument('--artifacts',required=True);args=parser.parse_args()
root=pathlib.Path(args.test_root).resolve();assert root.name.startswith(('huobao-platform-production-','huobao-production-','huobao-platform-registration-'))
artifacts=pathlib.Path(args.artifacts).resolve();artifacts.mkdir(parents=True,exist_ok=True)
initial=root/'admin-initial-password.txt';password=re.search(r'^Initial password: (.+)$',initial.read_text('utf-8'),re.M).group(1).strip() if initial.exists() else '1'
url=args.url;assert url=='http://127.0.0.1:15689';suffix=uuid.uuid4().hex[:7];gate=threading.Event();calls=[];errors=[];checks=[];lock=threading.Lock();failed_once=False
normalize=lambda value:re.sub('[^a-z]','',value.lower())
class Mock(http.server.BaseHTTPRequestHandler):
 protocol_version='HTTP/1.1'
 def log_message(self,*_):pass
 def send_json(self,value,status=200):
  data=json.dumps(value,ensure_ascii=False).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.send_header('Connection','close');self.end_headers();self.wfile.write(data)
 def do_POST(self):
  global failed_once
  body=json.loads(self.rfile.read(int(self.headers.get('Content-Length','0'))));messages=body.get('messages',[]);encoded=json.dumps(messages,ensure_ascii=False)
  with lock:calls.append({'path':self.path,'model':body.get('model'),'temperature':body.get('temperature'),'at':time.monotonic()})
  if not self.path.endswith('/chat/completions'):return self.send_json({'error':{'message':'Synthetic test forbids image/video generation'}},400)
  users='\n'.join(str(message.get('content','')) for message in messages if message.get('role')=='user')
  target='scenes' if '本次只提取场景' in users else 'props' if '本次只提取道具' in users else 'characters'
  tools={normalize(tool.get('function',{}).get('name','')):tool.get('function',{}).get('name') for tool in body.get('tools',[])}
  used=[normalize(call.get('function',{}).get('name','')) for message in messages if message.get('role')=='assistant' for call in message.get('tool_calls',[])]
  wanted='savededup'+target
  if 'readscriptforextraction' not in used:
   gate.wait(40);names=['readscriptforextraction','readexisting'+target];entries=[{'name':tools[name],'arguments':{}} for name in names if name in tools]
  elif wanted not in used:
   if target=='scenes' and 'FAIL_ONCE' in encoded and not failed_once:
    with lock:failed_once=True
    return self.send_json({'error':{'message':'SYNTHETIC_BATCH_SCENE_FAILURE'}},400)
   value=[{'name':'合成批次角色','appearance':'界面测试人物','styling':'测试服装'}] if target=='characters' else [{'location':'合成测试室','time':'白天','prompt':'界面测试空间','lighting':'自然光'}] if target=='scenes' else []
   entries=[{'name':tools[wanted],'arguments':{target:value}}] if wanted in tools else []
  else:entries=[]
  tool_calls=[{'index':index,'id':'call-'+uuid.uuid4().hex[:10],'type':'function','function':{'name':entry['name'],'arguments':json.dumps(entry['arguments'],ensure_ascii=False)}} for index,entry in enumerate(entries)]
  delta={'role':'assistant',**({'tool_calls':tool_calls} if tool_calls else {'content':'已调用原工具保存结果。'})};finish='tool_calls' if tool_calls else 'stop'
  if not body.get('stream'):
   message={'role':'assistant',**({'tool_calls':[{key:value for key,value in call.items() if key!='index'} for call in tool_calls]} if tool_calls else {'content':'已保存。'})}
   return self.send_json({'id':'local-test','object':'chat.completion','model':body.get('model'),'choices':[{'index':0,'message':message,'finish_reason':finish}],'usage':{'prompt_tokens':30,'completion_tokens':10,'total_tokens':40}})
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Connection','close');self.end_headers()
  packets=[{'id':'local-test','object':'chat.completion.chunk','model':body.get('model'),'choices':[{'index':0,'delta':delta,'finish_reason':None}]},{'id':'local-test','object':'chat.completion.chunk','model':body.get('model'),'choices':[{'index':0,'delta':{},'finish_reason':finish}],'usage':{'prompt_tokens':30,'completion_tokens':10,'total_tokens':40}}]
  try:self.wfile.write((''.join('data: '+json.dumps(packet,ensure_ascii=False)+'\n\n' for packet in packets)+'data: [DONE]\n\n').encode());self.wfile.flush()
  except (BrokenPipeError,ConnectionResetError):pass
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Mock);threading.Thread(target=server.serve_forever,daemon=True).start();mock_url='http://127.0.0.1:'+str(server.server_port)
def api(context,method,path,body=None):
 identity=context.request.get(url+'/api/v1/auth/me').json()['data'];response=context.request.fetch(url+'/api/v1'+path,method=method,data=body,headers={'X-CSRF-Token':identity['csrfToken']});value=response.json();assert response.ok and value.get('code',200)<400,(path,response.status,value.get('message'));return value.get('data',value)
def wait_for(page,callback,seconds=30):
 deadline=time.time()+seconds;value=None
 while time.time()<deadline:
  value=callback()
  if value:return value
  page.wait_for_timeout(100)
 raise AssertionError('Timed out waiting for actual backend state: '+str(value))
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path=r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',headless=True)
  context=browser.new_context(viewport={'width':1560,'height':1050},locale='zh-CN');context.add_init_script("for(let id=1;id<1000;id++)localStorage.setItem(`huobao:user:${id}:huobao:tours`,JSON.stringify(['index','detail','episode']));")
  page=context.new_page();page.on('pageerror',lambda error:errors.append(str(error)))
  page.goto(url+'/login');page.get_by_label('用户名',exact=True).fill('admin');page.get_by_label('密码',exact=True).fill(password);page.get_by_role('button',name='进入工作台',exact=True).click();page.wait_for_url(url+'/')
  channel=api(context,'POST','/admin/channels',{'name':'Batch synthetic '+suffix,'base_url':mock_url,'api_key':'synthetic-only','enabled':True})
  bindings={}
  for kind,protocol in [('text','text.openai-chat'),('image','image.openai'),('video','video.minimax')]:bindings[kind]=api(context,'POST',f'/admin/channels/{channel["id"]}/models',{'name':'Batch '+kind+' '+suffix,'model':'batch-test-'+kind+'-'+suffix,'type':kind,'protocol_id':protocol,'enabled':True,'access':'all','priority':1000100,'defaults':{'temperature':0.4} if kind=='text' else {}})
  project=api(context,'POST','/dramas',{'title':'批量看板验收 '+suffix,'style':'','aspect_ratio':'16:9'});episodes=[]
  for index in range(3):
   episode=api(context,'POST','/episodes',{'drama_id':project['id'],'title':'验收集 '+str(index+1),'image_config_id':bindings['image']['config_id'],'video_config_id':bindings['video']['config_id']})
   if index<2:api(context,'PUT',f'/episodes/{episode["id"]}',{'script_content':'第一集合成剧本\nFAIL_ONCE\n角色在测试室查看一份信物。'} if index==0 else {'content':'第二集原始剧本\n角色在测试室整理资料，没有关键道具。'})
   episodes.append(episode)
  original=api(context,'GET',f'/dramas/{project["id"]}')['episodes']
  page.goto(url+f'/drama/{project["id"]}');page.locator('.episode-batch-toolbar input').check();page.get_by_role('button',name='批量提取资产',exact=True).click();dialog=page.get_by_role('dialog',name='批量提取资产',exact=True)
  expect(dialog).to_contain_text('已选 2 / 2 集');expect(dialog.locator('.batch-episodes input:disabled')).to_have_count(1);dialog.get_by_label('批次并发',exact=True).select_option('2')
  dialog.locator('.batch-model .model-select-trigger').click();page.get_by_role('menuitem').filter(has_text='Batch text '+suffix).click()
  page.screenshot(path=str(artifacts/'01-batch-selection.png'),full_page=True)
  with page.expect_response(lambda response:response.request.method=='POST' and response.url.endswith('/production-batches')) as accepted:dialog.get_by_role('button',name='确认开始提取',exact=True).click()
  assert accepted.value.status==202;batch=accepted.value.json()['data'];batch_id=batch['id'];page.wait_for_url(re.compile('/production\\?'))
  wait_for(page,lambda:len(calls)>=2);page.get_by_role('button',name='暂停派发',exact=True).click();wait_for(page,lambda:api(context,'GET','/production-batches/'+batch_id)['status']=='paused');gate.set()
  wait_for(page,lambda:api(context,'GET','/production-batches/'+batch_id)['counts']['completed']==2)
  paused=api(context,'GET','/production-batches/'+batch_id);assert paused['counts']['queued']==4 and paused['counts']['running']==0,paused['counts'];assert len(calls)==6,calls
  checks.append('real multi-select excludes empty content, creates one HTTP202 batch, accepts original content without rewriting, runs two episodes and pauses new dispatch while finishing in-flight work')
  page.get_by_role('button',name='继续派发',exact=True).click()
  failed=wait_for(page,lambda:(value if (value:=api(context,'GET','/production-batches/'+batch_id))['status']=='completed_with_errors' else None))
  assert failed['counts']['failed']==1 and failed['counts']['blocked']==1 and failed['counts']['completed']==4,failed['counts']
  page.get_by_role('button',name='刷新',exact=True).click();page.get_by_label('只看需关注',exact=True).check();expect(page.locator('.production-table tbody tr')).to_have_count(1)
  page.locator('.production-step').filter(has_text='提取场景').first.click();expect(page.locator('.inspector-exception')).to_contain_text('SYNTHETIC_BATCH_SCENE_FAILURE')
  expect(page.locator('.production-inspector')).to_contain_text('HTTP 状态');expect(page.locator('.production-inspector')).to_contain_text('400')
  log_url=page.get_by_role('link',name='定位 AI 实况').get_attribute('href');assert 'task_id=' in log_url and 'round_id=' in log_url
  settings_url=page.get_by_role('link',name='检查模型配置').get_attribute('href');assert 'channel_id='+str(channel['id']) in settings_url and 'config_id='+str(bindings['text']['config_id']) in settings_url
  settings_page=context.new_page();settings_page.goto(url+settings_url);expect(settings_page.locator('.channel-card.selected')).to_contain_text('Batch synthetic '+suffix);expect(settings_page.locator('.channel-table tr.is-located')).to_have_attribute('data-config-id',str(bindings['text']['config_id']));settings_page.screenshot(path=str(artifacts/'05-real-channel-model-location.png'),full_page=True);settings_page.close()
  page.screenshot(path=str(artifacts/'02-failed-step-dashboard.png'),full_page=True)
  page.once('dialog',lambda modal:modal.accept());page.get_by_role('button',name=re.compile('仅重试失败')).click()
  completed=wait_for(page,lambda:(value if (value:=api(context,'GET','/production-batches/'+batch_id))['status']=='completed' else None))
  assert completed['counts']['completed']==6 and completed['counts']['failed']==0
  assert sum(step['attempt']==2 for step in completed['steps'])==1
  assert all(step['status']=='completed' and step['receipt']['created']==0 and step['receipt']['saved_calls']>0 for step in completed['steps'] if step['target']=='props')
  assert api(context,'GET',f'/episodes/{episodes[0]["id"]}/props')==[]
  checks.append('actual save-tool receipts drive success including zero props; one real HTTP400 fails one scene step, server exception filter locates it, and explicit retry reruns only the failed step plus its blocked successor')
  saved_project=api(context,'GET',f'/dramas/{project["id"]}');current=saved_project['episodes'];assert len(saved_project['characters'])==1 and len(saved_project['scenes'])==1 and not saved_project['props']
  assert [(ep.get('content'),ep.get('script_content')) for ep in original]==[(ep.get('content'),ep.get('script_content')) for ep in current]
  asset_page=context.new_page();asset_page.goto(url+f'/drama/{project["id"]}?tab=assets&asset_kind=character&asset_id={saved_project["characters"][0]["id"]}');expect(asset_page.locator('.mat-detail-title')).to_contain_text('合成批次角色');asset_page.screenshot(path=str(artifacts/'06-real-asset-location.png'),full_page=True);asset_page.close()
  before=len(calls);page.reload();expect(page.locator('.batch-summary-row')).to_contain_text('已完成');page.wait_for_timeout(5600);assert len(calls)==before
  page.screenshot(path=str(artifacts/'03-completed-batch.png'),full_page=True)
  page.goto(url+log_url);expect(page.locator('.activity-detail-header')).to_contain_text('提取场景');expect(page.locator('.follow-round input')).not_to_be_checked();page.screenshot(path=str(artifacts/'04-deep-linked-round.png'),full_page=True)
  checks.append('refresh never resubmits a batch, original script/content stay byte-identical, and deep links open the actual activity and requested real round')
  user=browser.new_context();userpage=user.new_page();userpage.goto(url+'/register');userpage.get_by_label('用户名',exact=True).fill('batch-private-'+suffix);userpage.get_by_label('密码',exact=True).fill('x');userpage.get_by_label('再次输入密码',exact=True).fill('x');userpage.get_by_role('button',name='注册并进入工作台',exact=True).click();userpage.wait_for_url(url+'/')
  for path in [f'/production-dashboard?project_id={project["id"]}','/production-batches/'+batch_id]:assert user.request.get(url+'/api/v1'+path).status in [403,404]
  assert user.request.get(url+'/api/v1/production-dashboard').json()['data']['projects']==[]
  checks.append('another ordinary user cannot read this project dashboard or batch and sees only its own authorized project scope')
  assert all(call['path'].endswith('/chat/completions') for call in calls),calls
  assert all(call['model']==bindings['text']['model'] and call['temperature']==0.4 for call in calls),calls
  assert not errors,errors
  browser.close()
 result={'passed':len(checks),'checks':checks,'page_errors':errors,'paid_requests':0,'model_http_requests':len(calls),'image_video_requests':0,'batch_id':batch_id,'project_id':project['id'],'final_counts':completed['counts']}
 (artifacts/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),'utf-8');print(json.dumps({'passed':len(checks),'paid_requests':0,'page_errors':len(errors),'model_http_requests':len(calls)},ensure_ascii=False))
except Exception:
 (artifacts/'failure-context.json').write_text(json.dumps({'checks':checks,'page_errors':errors,'model_calls':calls},ensure_ascii=False,indent=2),'utf-8');raise
finally:gate.set();server.shutdown();server.server_close()
