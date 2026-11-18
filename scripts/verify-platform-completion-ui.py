"""Real HTTP browser verification with a localhost-only upstream. No paid models.

Runs only against an isolated huobao-platform-integration-* data directory on :15679.
All generated media/text come from the synthetic local upstream below.
"""
import argparse,base64,binascii,hashlib,http.server,io,json,pathlib,re,sqlite3,struct,threading,time,uuid,zipfile,zlib
from email.parser import BytesParser
from email.policy import default as email_policy
from playwright.sync_api import sync_playwright,expect

parser=argparse.ArgumentParser()
parser.add_argument('--test-root',required=True)
parser.add_argument('--artifacts',required=True)
args=parser.parse_args()
root=pathlib.Path(args.test_root).resolve()
assert root.name.startswith('huobao-platform-integration-'), 'An isolated integration directory is required.'
url='http://127.0.0.1:15679'
artifacts=pathlib.Path(args.artifacts).resolve();artifacts.mkdir(parents=True,exist_ok=True)
credentials=(root/'admin-initial-password.txt').read_text('utf-8')
password=re.search(r'^Initial password: (.+)$',credentials,re.M).group(1).strip()
suffix=uuid.uuid4().hex[:7]
checks=[];page_errors=[];upstream=[];polls={};video_bytes=b''
synthetic_key='synthetic-local-only-key-'+suffix
synthetic_extra='synthetic-extra-'+suffix

def png(color):
    def chunk(name,data):return struct.pack('!I',len(data))+name+data+struct.pack('!I',binascii.crc32(name+data)&0xffffffff)
    width,height=256,144
    raw=b''.join(b'\x00'+bytes(color)*width for _ in range(height))
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('!IIBBBBB',width,height,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(raw))+chunk(b'IEND',b'')
red=png((236,122,67));blue=png((65,135,199))
(artifacts/'reference-one.png').write_bytes(red);(artifacts/'reference-two.png').write_bytes(blue)

def reference_bytes(value):
    if isinstance(value,dict):value=value.get('image_url') or value.get('url') or value.get('data_url')
    if isinstance(value,dict):value=value.get('url')
    if isinstance(value,str) and value.startswith('data:'):return base64.b64decode(value.split(',',1)[1])
    return None

class Mock(http.server.BaseHTTPRequestHandler):
    protocol_version='HTTP/1.1'
    def log_message(self,*_):pass
    def send_bytes(self,data,content='application/json',status=200):
        self.send_response(status);self.send_header('Content-Type',content);self.send_header('Content-Length',str(len(data)));self.send_header('Connection','close');self.end_headers();self.wfile.write(data)
    def send_json(self,data,status=200):self.send_bytes(json.dumps(data,ensure_ascii=False).encode(),'application/json',status)
    def do_GET(self):
        if self.path.startswith('/v1/models'):
            return self.send_json({'data':[{'id':'ui-text-'+suffix,'type':'text','capabilities':{'reasoning_efforts':['low','high']}}]})
        if self.path.startswith('/mock/videos/'):
            task=self.path.split('/')[-1];polls[task]=polls.get(task,0)+1;count=polls[task]
            state='processing' if count<4 else 'succeeded';progress=[23,47,76,100][min(count-1,3)]
            upstream.append({'kind':'video_poll','task':task,'progress':progress,'status':state})
            return self.send_json({'id':task,'status':state,'progress':progress,'url':mock_url+'/result.webm' if state=='succeeded' else None})
        if self.path.startswith('/result.webm'):return self.send_bytes(video_bytes,'video/webm')
        if self.path.startswith('/output-one.png'):return self.send_bytes(red,'image/png')
        if self.path.startswith('/output-two.png'):return self.send_bytes(blue,'image/png')
        return self.send_json({'error':'Synthetic route missing'},404)
    def do_POST(self):
        data=self.rfile.read(int(self.headers.get('Content-Length','0')))
        content=self.headers.get('Content-Type','');body={};files=[]
        if 'multipart/form-data' in content:
            parsed=BytesParser(policy=email_policy).parsebytes(('Content-Type: '+content+'\r\nMIME-Version: 1.0\r\n\r\n').encode()+data)
            for part in parsed.iter_parts():
                name=part.get_param('name',header='content-disposition');value=part.get_payload(decode=True)
                if part.get_filename():files.append(value)
                elif name:body[name]=value.decode('utf-8')
        elif data:body=json.loads(data)
        record={'path':self.path,'model':body.get('model'),'prompt':body.get('prompt'),'kind':'text' if 'chat/completions' in self.path else 'image' if '/images/' in self.path else 'video','authorization_ok':self.headers.get('Authorization')=='Bearer '+synthetic_key}
        if 'chat/completions' in self.path:
            record.update({'temperature':body.get('temperature'),'max_tokens':body.get('max_tokens'),'reasoning_effort':body.get('reasoning_effort'),'stream':body.get('stream')})
            upstream.append(record)
            if body.get('stream'):
                self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Cache-Control','no-cache');self.send_header('Connection','close');self.end_headers()
                parts=['真实 HTTP 增量测试：','第一段已经到达，','第二段继续返回，','第三段仍在运行，','第四段保留原文，','第五段不含隐藏思考，','第六段接近结束，','最终完成。']
                try:
                    for index,part in enumerate(parts):
                        item={'id':'synthetic-stream','object':'chat.completion.chunk','created':int(time.time()),'model':body.get('model'),'choices':[{'index':0,'delta':{'content':part,**({'role':'assistant'} if index==0 else {})},'finish_reason':None}]}
                        self.wfile.write(('data: '+json.dumps(item,ensure_ascii=False)+'\n\n').encode());self.wfile.flush();time.sleep(0.7)
                    item={'id':'synthetic-stream','object':'chat.completion.chunk','created':int(time.time()),'model':body.get('model'),'choices':[{'index':0,'delta':{},'finish_reason':'stop'}],'usage':{'prompt_tokens':31,'completion_tokens':19,'total_tokens':50}}
                    self.wfile.write(('data: '+json.dumps(item)+'\n\ndata: [DONE]\n\n').encode());self.wfile.flush()
                except (BrokenPipeError,ConnectionResetError):pass
                return
            return self.send_json({'id':'synthetic-text','object':'chat.completion','created':int(time.time()),'model':body.get('model'),'choices':[{'index':0,'message':{'role':'assistant','content':'真实 HTTP 非流式测试完成。'},'finish_reason':'stop'}],'usage':{'prompt_tokens':31,'completion_tokens':19,'total_tokens':50}})
        if '/images/' in self.path:
            references=files or [reference_bytes(item) for item in body.get('images',[])]
            record.update({'image_hashes':[hashlib.sha256(item).hexdigest() if item is not None else 'unresolved-reference' for item in references],'quality':body.get('quality'),'image_count':body.get('n'),'extra_auth_ok':self.headers.get('X-Extra-Auth')==synthetic_extra})
            upstream.append(record)
            return self.send_json({'created':int(time.time()),'data':[{'url':mock_url+'/output-one.png'},{'url':mock_url+'/output-two.png'}]})
        if self.path.endswith('/mock/videos'):
            task='mock-'+uuid.uuid4().hex[:8];record.update({'duration':body.get('duration'),'resolution':body.get('resolution'),'aspect_ratio':body.get('aspectRatio')});upstream.append(record);polls[task]=0
            return self.send_json({'id':task,'status':'queued','progress':0})
        upstream.append(record);return self.send_json({'error':{'message':'Synthetic endpoint is not configured'}},400)

server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Mock)
mock_url='http://127.0.0.1:'+str(server.server_port)
threading.Thread(target=server.serve_forever,daemon=True).start()

def verify(name):checks.append(name)
def api(context,method,path,body=None):
    me=context.request.get(url+'/api/v1/auth/me').json()['data']
    response=context.request.fetch(url+'/api/v1'+path,method=method,data=body,headers={'X-CSRF-Token':me['csrfToken']})
    value=response.json()
    assert response.ok and value.get('code',200)<400,(method,path,response.status,value.get('message'))
    return value.get('data',value)
def wait_terminal(context,task_id,timeout=90):
    deadline=time.time()+timeout
    while time.time()<deadline:
        value=api(context,'GET','/admin/model-tests/'+task_id)
        if value['status'] in ['completed','failed','interrupted']:return value
        time.sleep(.3)
    raise AssertionError('Synthetic task did not terminate: '+task_id)
def fill_parameter(dialog,label,value):
    field=dialog.get_by_label(label,exact=True)
    if field.count()==0:
        row=dialog.locator('.parameter-field').filter(has=dialog.locator('code').get_by_text(label,exact=True))
        field=row.locator('select,input,textarea').first
    if field.count()==0:return False
    if field.evaluate('(element)=>element.tagName')=='SELECT':field.select_option(json.dumps(value,ensure_ascii=False))
    elif isinstance(value,bool):field.set_checked(value)
    else:field.fill(str(value));field.press('Tab')
    return True

try:
  with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',headless=True)
    context=browser.new_context(viewport={'width':1440,'height':1000},locale='zh-CN')
    context.add_init_script("for(let id=1;id<200;id++)localStorage.setItem(`huobao:user:${id}:huobao:tours`,JSON.stringify(['index','detail','episode']));")
    page=context.new_page();page.on('pageerror',lambda error:page_errors.append(str(error)))
    # Generate a valid local WebM; this has no remote network or model interaction.
    video_bytes=bytes(page.evaluate("""async()=>{const c=document.createElement('canvas');c.width=320;c.height=180;const x=c.getContext('2d');x.fillStyle='#4788bc';x.fillRect(0,0,320,180);const chunks=[];const stream=c.captureStream(12);const r=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'});return await new Promise(resolve=>{r.ondataavailable=e=>chunks.push(e.data);r.onstop=async()=>{stream.getTracks().forEach(t=>t.stop());resolve(Array.from(new Uint8Array(await new Blob(chunks,{type:'video/webm'}).arrayBuffer())))};r.start();setTimeout(()=>{x.fillStyle='#f07b39';x.fillRect(40,40,180,90)},100);setTimeout(()=>r.stop(),600)})}"""))
    assert video_bytes.startswith(bytes.fromhex('1a45dfa3'));(artifacts/'synthetic-result.webm').write_bytes(video_bytes)
    page.goto(url+'/login');page.get_by_label('用户名',exact=True).fill('admin');page.get_by_label('密码',exact=True).fill(password);page.get_by_role('button',name='进入工作台').click();page.wait_for_url(lambda value:'/login' not in value)
    protocols=api(context,'GET','/admin/protocols')
    assert len([item for item in protocols if item.get('source')=='bundled-yingce-v2'])>=100
    verify('real backend exposes the complete bundled Yingce protocol catalog')
    # Import an actual v2 plugin package using the UI and preview/confirm endpoints.
    source=pathlib.Path(__file__).resolve().parents[1]/'backend/src/services/model-channels/bundled/openai-images.json'
    manifest=json.loads(source.read_text('utf-8'));old_id=manifest['contributes']['providers'][0]['id'];provider_id='ui-image-'+suffix
    manifest=json.loads(json.dumps(manifest,ensure_ascii=False).replace(old_id,provider_id))
    manifest.update({'id':'ui-completion-'+suffix,'name':'UI HTTP 图片协议 '+suffix,'version':'2.0.1'})
    manifest['contributes']['providers'][0]['label']='UI HTTP 图片协议 '+suffix
    manifest['configuration']['fields'].append({'name':'extraToken','type':'secret','label':'额外鉴权字段','required':False})
    manifest['contributes']['providers'][0]['auth']={'type':'header','field':'extraToken','header':'X-Extra-Auth'}
    plugin_path=artifacts/('synthetic-'+suffix+'.yingce-plugin')
    with zipfile.ZipFile(plugin_path,'w',zipfile.ZIP_DEFLATED) as package:package.writestr('manifest.json',json.dumps(manifest,ensure_ascii=False))
    page.goto(url+'/admin/channels');page.get_by_role('button',name='导入影策插件',exact=True).click();dialog=page.get_by_role('dialog',name='导入影策插件')
    dialog.locator('input[type=file]').set_input_files(str(plugin_path));dialog.get_by_role('button',name='校验预览',exact=True).click()
    expect(dialog.get_by_text('UI HTTP 图片协议 '+suffix,exact=True).first).to_be_visible(timeout=15000)
    assert not any(item['id']=='engine.'+provider_id for item in api(context,'GET','/admin/protocols'))
    dialog.get_by_role('button',name='确认导入',exact=True).click();expect(dialog.get_by_text('插件已导入，可在模型的“请求协议”中选择。')).to_be_visible(timeout=15000)
    page.screenshot(path=str(artifacts/'01-yingce-plugin-import.png'),full_page=True);dialog.get_by_role('button',name='关闭',exact=True).click()
    verify('real .yingce-plugin ZIP preview and explicit import create an executable protocol without generation')
    channel=api(context,'POST','/admin/channels',{'name':'UI Loopback '+suffix,'base_url':mock_url,'api_key':synthetic_key,'auth_fields':{'apiKey':synthetic_key,'extraToken':synthetic_extra},'enabled':True})
    channel_id=channel['id']
    text=api(context,'POST',f'/admin/channels/{channel_id}/models',{'name':'UI 文字 '+suffix,'model':'ui-text-'+suffix,'type':'text','protocol_id':'text.openai-chat','enabled':True,'access':'all','priority':100000,'defaults':{'temperature':0.23,'max_tokens':81,'reasoning_effort':'high'}})
    image=api(context,'POST',f'/admin/channels/{channel_id}/models',{'name':'UI 图片 B '+suffix,'model':'ui-image-b-'+suffix,'type':'image','protocol_id':'engine.'+provider_id,'enabled':True,'access':'all','priority':10,'capabilities':{'max_images':2},'defaults':{'quality':'high','count':2}})
    other_image=api(context,'POST',f'/admin/channels/{channel_id}/models',{'name':'UI 图片 A '+suffix,'model':'ui-image-a-'+suffix,'type':'image','protocol_id':'engine.'+provider_id,'enabled':True,'access':'all','priority':100000,'defaults':{'quality':'high','count':1}})
    protocol_id='custom.ui-video-'+suffix
    api(context,'POST','/admin/protocols',{'id':protocol_id,'name':'UI HTTP 视频协议 '+suffix,'definition':{'type':'video','create':{'method':'POST','path':'/mock/videos','body':{'model':'{{model}}','prompt':'{{prompt}}','duration':'{{duration}}','resolution':'{{resolution}}','aspectRatio':'{{aspectRatio}}'}},'poll':{'method':'GET','path':'/mock/videos/{{taskId}}'},'response':{'task_id':'id','status':'status','progress':'progress','result_url':'url','error':'error','succeeded':['succeeded'],'failed':['failed'],'queued':['queued']}},'capabilities':{'max_images':2,'resolutions':['540p','720p'],'durations':[5,10]}})
    video=api(context,'POST',f'/admin/channels/{channel_id}/models',{'name':'UI 视频 '+suffix,'model':'ui-video-'+suffix,'type':'video','protocol_id':protocol_id,'enabled':True,'access':'all','priority':100000,'capabilities':{'resolutions':['540p','720p'],'durations':[5,10]},'defaults':{'duration':5,'resolution':'540p','aspect_ratio':'16:9'}})
    page.reload();page.locator('.channel-card').filter(has_text='UI Loopback '+suffix).click();page.get_by_role('button',name='编辑',exact=True).click();dialog=page.get_by_role('dialog')
    dialog.get_by_label('鉴权字段模板',exact=False).select_option('engine.'+provider_id)
    expect(dialog.get_by_label('额外鉴权字段',exact=False)).to_have_value('')
    dialog.get_by_role('button',name='保存渠道',exact=True).click()
    stored=api(context,'GET','/admin/channels')['channels'];stored=next(item for item in stored if item['id']==channel_id)
    assert 'extraToken' in stored['has_auth_fields'] and synthetic_extra not in json.dumps(stored)
    verify('dynamic secret auth fields are masked on reload and blank edits preserve encrypted stored values')
    page.goto(url+'/admin/playground');page.get_by_label('测试模型',exact=True).select_option(str(text['config_id']))
    page.locator('.test-prompt').fill('UI_TEXT_STREAM_'+suffix)
    assert fill_parameter(page,'采样温度',0.37);assert fill_parameter(page,'最大输出 Token',81)
    with page.expect_response(lambda response:response.request.method=='POST' and response.url.endswith('/api/v1/admin/model-tests')) as created:
        page.get_by_role('button',name='发送文字测试',exact=True).click()
    text_id=created.value.json()['data']['id']
    page.get_by_role('button',name='查看完整日志',exact=True).click();expect(page.locator('.activity-output-box')).to_contain_text('真实 HTTP 增量测试',timeout=12000)
    state=api(context,'GET','/admin/model-tests/'+text_id)
    assert state['status']=='running','The observed public text must arrive before terminal completion.'
    page.screenshot(path=str(artifacts/'02-real-streaming-text.png'),full_page=True);page.get_by_role('button',name='关闭任务日志',exact=True).click()
    terminal=wait_terminal(context,text_id);assert terminal['status']=='completed',terminal.get('error')
    sent=next(item for item in upstream if item['kind']=='text');assert sent['temperature']==0.37 and sent['max_tokens']==81 and sent['stream'] is True and sent['authorization_ok']
    verify('real text POST uses declared parameters and SSE public text is visible before completion')
    page.locator('.test-type-tabs button').filter(has_text='图片').click();page.get_by_label('测试模型',exact=True).select_option(str(image['config_id']))
    page.locator('.test-prompt').fill('UI_IMAGE_REFERENCE_'+suffix)
    assert fill_parameter(page,'quality','low') or fill_parameter(page,'质量','low')
    assert fill_parameter(page,'count',2) or fill_parameter(page,'imageCount',2)
    page.locator('.test-references input[type=file]').set_input_files([str(artifacts/'reference-one.png'),str(artifacts/'reference-two.png')]);expect(page.get_by_role('button',name='上传素材',exact=True)).to_be_enabled(timeout=12000)
    with page.expect_response(lambda response:response.request.method=='POST' and response.url.endswith('/api/v1/admin/model-tests')) as created:
        page.get_by_role('button',name='发送图片测试',exact=True).click()
    image_id=created.value.json()['data']['id'];terminal=wait_terminal(context,image_id);assert terminal['status']=='completed',terminal.get('error')
    expect(page.locator('.test-gallery button')).to_have_count(2,timeout=12000)
    expect(page.locator('.test-download-list a')).to_have_count(2)
    page.wait_for_function("document.querySelector('.test-result-image')?.naturalWidth===256")
    first_url=page.locator('.test-result-image').get_attribute('src');page.locator('.test-gallery button').nth(1).click()
    page.wait_for_function("document.querySelector('.test-result-image')?.naturalWidth===256")
    assert page.locator('.test-result-image').get_attribute('src')!=first_url
    sent=next(item for item in upstream if item['kind']=='image' and item['prompt']=='UI_IMAGE_REFERENCE_'+suffix)
    assert sent['image_hashes']==[hashlib.sha256(red).hexdigest(),hashlib.sha256(blue).hexdigest()],sent
    assert sent['quality']=='low' and int(sent['image_count'])==2 and sent['extra_auth_ok'],sent
    page.locator('.admin-main').evaluate('(element)=>element.scrollTop=0')
    page.screenshot(path=str(artifacts/'03-real-image-gallery.png'),full_page=True)
    verify('real image upload carries ordered original PNG bytes, dynamic auth and quality; two outputs are saved and downloadable')
    page.locator('.test-type-tabs button').filter(has_text='视频').click();page.get_by_label('测试模型',exact=True).select_option(str(video['config_id']));page.locator('.test-prompt').fill('UI_VIDEO_POLL_'+suffix)
    assert fill_parameter(page,'视频时长（秒）',5);assert fill_parameter(page,'分辨率','540p')
    with page.expect_response(lambda response:response.request.method=='POST' and response.url.endswith('/api/v1/admin/model-tests')) as created:
        page.get_by_role('button',name='发送视频测试',exact=True).click()
    video_id=created.value.json()['data']['id']
    expect(page.locator('.test-progress')).to_contain_text(re.compile(r'23%|47%|76%'),timeout=18000)
    page.locator('.admin-main').evaluate('(element)=>element.scrollTop=0')
    page.screenshot(path=str(artifacts/'04-real-video-progress.png'),full_page=True)
    terminal=wait_terminal(context,video_id);assert terminal['status']=='completed',terminal.get('error')
    expect(page.locator('.test-result-video')).to_be_visible(timeout=12000)
    page.wait_for_function("document.querySelector('.test-result-video')?.videoWidth===320",timeout=15000)
    sent=next(item for item in upstream if item['kind']=='video');assert sent['duration']==5 and sent['resolution']=='540p' and sent['aspect_ratio']=='16:9'
    verify('real mock video polls propagate changing upstream percentages and persist a valid video without another generation POST')
    # Exercise project/episode model selection on the original creative pages.
    project=api(context,'POST','/dramas',{'title':'UI Private '+suffix,'style':'','aspect_ratio':'9:16'})
    episode=api(context,'POST','/episodes',{'drama_id':project['id'],'title':'UI episode','image_config_id':image['config_id'],'video_config_id':video['config_id'],'resolution':'720p'})
    character=api(context,'POST','/characters',{'drama_id':project['id'],'episode_id':episode['id'],'name':'UI角色'+suffix,'appearance':'独立测试人物','styling':'测试服装'})
    api(context,'PUT',f'/characters/{character["id"]}',{'final_prompt':'PROJECT_ASSET_REFERENCE_TEST_'+suffix})
    page.goto(url+f'/drama/{project["id"]}/episode/{episode.get("episode_number",1)}')
    expect(page.locator('.studio-model-picks .model-select').filter(has=page.locator('.model-select-label').get_by_text('图片',exact=True)).locator('.model-select-value')).to_contain_text('UI 图片 B '+suffix)
    verify('episode default image label follows the locked lower-priority authorized binding')
    page.goto(url+f'/drama/{project["id"]}');page.locator('.page-tabs button').filter(has_text='素材库').click()
    expect(page.locator('.project-model-bar')).to_be_visible();expect(page.locator('.project-model-bar')).to_contain_text('UI 图片 B '+suffix)
    page.locator('.character-gen-btn').first.click()
    deadline=time.time()+30
    while time.time()<deadline and not any(item.get('prompt')=='PROJECT_ASSET_REFERENCE_TEST_'+suffix for item in upstream):time.sleep(.2)
    request=next(item for item in upstream if item.get('prompt')=='PROJECT_ASSET_REFERENCE_TEST_'+suffix)
    assert request['model']=='ui-image-b-'+suffix,request
    page.screenshot(path=str(artifacts/'05-project-model-selection.png'),full_page=True)
    verify('project material generation sends the selected/locked image binding through real HTTP rather than the higher-priority model')
    # Only this boundary test appends synthetic log events; generation/progress tests above are all real HTTP.
    db=sqlite3.connect(root/'test.sqlite3',timeout=15);before=db.execute('SELECT count(*) FROM platform_activity_events WHERE task_id=?',(text_id,)).fetchone()[0]
    for index in range(700):db.execute('INSERT INTO platform_activity_events(task_id,kind,message,payload_json,created_at) VALUES(?,?,?,?,datetime("now"))',(text_id,'qa-boundary','完整导出边界 '+str(index),json.dumps({'index':index})))
    db.commit();db.close()
    detail=api(context,'GET','/activity/tasks/'+text_id);assert len(detail['events'])==500 and detail['events_page']['total']==before+700
    earlier=api(context,'GET','/activity/tasks/'+text_id+'/events?before='+str(detail['events'][0]['id'])+'&limit=500');assert earlier['items']
    page.goto(url+'/tasks');page.get_by_role('button').filter(has=page.get_by_text('文字模型试用 · ui-text-'+suffix,exact=True)).first.click()
    with page.expect_download() as download:page.get_by_role('button',name='导出记录',exact=True).click()
    exported=json.loads(pathlib.Path(download.value.path()).read_text('utf-8'));assert len(exported['events'])==before+700
    assert {row['payload']['index'] for row in exported['events'] if row['kind']=='qa-boundary'}==set(range(700))
    page.screenshot(path=str(artifacts/'06-complete-event-export.png'),full_page=True)
    verify('500-event UI paging and complete server export retain all 700 boundary events plus real stream events')
    page.set_viewport_size({'width':390,'height':844});page.goto(url+'/admin/playground');page.get_by_label('测试模型',exact=True).select_option(str(text['config_id']));page.screenshot(path=str(artifacts/'07-mobile-playground.png'),full_page=True)
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
    assert not page_errors,page_errors
    verify('desktop/mobile production UI has no page exceptions or horizontal body overflow')
    browser.close()
  output={'checks':checks,'passed':len(checks),'page_errors':page_errors,'paid_requests':0,'localhost_only_upstream':mock_url,'upstream_calls':upstream,'text_activity_id':text_id,'image_activity_id':image_id,'video_activity_id':video_id,'exported_events':before+700}
  (artifacts/'result.json').write_text(json.dumps(output,ensure_ascii=False,indent=2),'utf-8')
  print(json.dumps({'passed':len(checks),'page_errors':len(page_errors),'paid_requests':0,'artifacts':str(artifacts)},ensure_ascii=False))
except Exception:
  (artifacts/'failure-context.json').write_text(json.dumps({'passed_checks':checks,'page_errors':page_errors,'upstream_calls':upstream,'paid_requests':0},ensure_ascii=False,indent=2),'utf-8')
  raise
finally:
  server.shutdown();server.server_close()
