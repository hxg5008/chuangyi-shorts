"""Real UI layout checks against the isolated local fixture; no model requests."""
import argparse,binascii,json,pathlib,re,struct,uuid,zlib
from playwright.sync_api import sync_playwright,expect

parser=argparse.ArgumentParser()
parser.add_argument('--url',default='http://127.0.0.1:15679')
parser.add_argument('--test-root',required=True)
parser.add_argument('--artifacts',required=True)
args=parser.parse_args()
assert args.url=='http://127.0.0.1:15679'
root=pathlib.Path(args.test_root).resolve();assert root.name.startswith('huobao-platform-registration-')
artifacts=pathlib.Path(args.artifacts).resolve();artifacts.mkdir(parents=True,exist_ok=True)
initial=root/'admin-initial-password.txt'
password=re.search(r'^Initial password: (.+)$',initial.read_text('utf-8'),re.M).group(1).strip() if initial.exists() else '1'
suffix=uuid.uuid4().hex[:7];checks=[];errors=[];generation_requests=[];measurements=[]

def png(width=320,height=1600):
 def chunk(name,data):return struct.pack('!I',len(data))+name+data+struct.pack('!I',binascii.crc32(name+data)&0xffffffff)
 rows=b''.join(b'\x00'+bytes((65+int(y/height*80),135,199))*width for y in range(height))
 return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('!IIBBBBB',width,height,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(rows))+chunk(b'IEND',b'')
def api(context,method,path,body=None):
 identity=context.request.get(args.url+'/api/v1/auth/me').json()['data']
 response=context.request.fetch(args.url+'/api/v1'+path,method=method,data=body,headers={'X-CSRF-Token':identity['csrfToken']})
 value=response.json();assert response.ok and value.get('code',200)<400,(path,response.status,value.get('message'))
 return value.get('data',value)
def check(label):checks.append(label)
def compact_account(page,role,username):
 menu=page.locator('.account-menu');expect(menu).to_be_visible()
 expect(menu.locator('.account-role-badge')).to_have_text(role)
 expect(menu.locator('.account-entry-label')).to_have_text('我的账户')
 expect(menu.locator('button[aria-label="退出登录"]')).to_have_count(1)
 assert username not in menu.inner_text()
 assert menu.inner_text().count(role)==1
 box=menu.bounding_box();assert box['x']>=0 and box['x']+box['width']<=page.viewport_size['width']+1,{'account_menu':box,'viewport':page.viewport_size}
 measurements.append({'label':role+' account entry contained','box':box,'viewport':page.viewport_size})
def within_viewport(page,locator,label):
 expect(locator).to_be_visible()
 page.wait_for_timeout(250)
 box=locator.bounding_box();viewport=page.viewport_size
 assert box and box['x']>=-1 and box['y']>=-1 and box['x']+box['width']<=viewport['width']+1 and box['y']+box['height']<=viewport['height']+1,(label,box,viewport)
 measurements.append({'label':label,'box':box,'viewport':viewport})
def scrolled_bottom(page):
 page.locator('.page').evaluate('(element)=>element.scrollTop=element.scrollHeight')
 page.wait_for_timeout(100)
 value=page.locator('.page').evaluate('(element)=>element.scrollTop')
 assert value>1000,{'expected':'actual inner page scrolled >1000','actual':value}
 measurements.append({'label':'deep project scroll before opening','pageScrollTop':value,'windowScrollY':page.evaluate('window.scrollY')})
 return value
def stable_background(page,previous):
 current=page.locator('.page').evaluate('(element)=>element.scrollTop')
 assert abs(current-previous)<=1,{'before':previous,'after':current}
 measurements.append({'label':'background position retained','before':previous,'after':current,'windowScrollY':page.evaluate('window.scrollY')})
def edit_bounds(page,label):
 dialog=page.locator('.mat-detail-dialog');overlay=page.locator('.mat-detail-overlay')
 within_viewport(page,dialog,label)
 box=overlay.bounding_box();viewport=page.viewport_size
 assert abs(box['x'])<=1 and abs(box['y'])<=1 and abs(box['width']-viewport['width'])<=1 and abs(box['height']-viewport['height'])<=1,box
 measurements.append({'label':label+' overlay','box':box,'viewport':viewport})
 assert overlay.evaluate('(element)=>element.parentElement===document.body'),'The modal must be teleported out of the scrolling/animated project page.'
 expect(dialog.locator('.mat-detail-foot').get_by_role('button',name='关闭',exact=True)).to_be_visible()
 return dialog
def close_edit(page,previous):
 page.locator('.mat-detail-dialog .mat-detail-foot').get_by_role('button',name='关闭',exact=True).click()
 expect(page.locator('.mat-detail-dialog')).to_have_count(0)
 stable_background(page,previous)

try:
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path=r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',headless=True)
  context=browser.new_context(viewport={'width':1440,'height':900},locale='zh-CN')
  context.add_init_script("for(let id=1;id<1000;id++)localStorage.setItem(`huobao:user:${id}:huobao:tours`,JSON.stringify(['index','detail','episode']));")
  page=context.new_page();page.on('pageerror',lambda error:errors.append(str(error)))
  page.on('request',lambda request:generation_requests.append(request.url) if request.method=='POST' and any(part in request.url for part in ['/generate-image','/generate-prompt','/generation/','/model-tests','/agents/']) else None)
  page.goto(args.url+'/login');page.get_by_label('用户名',exact=True).fill('admin');page.get_by_label('密码',exact=True).fill(password);page.get_by_role('button',name='进入工作台',exact=True).click();page.wait_for_url(args.url+'/')
  compact_account(page,'管理员','admin')
  page.get_by_role('link',name='我的账户与修改密码',exact=True).click()
  expect(page.locator('.account-info>p')).to_have_attribute('title','admin')
  page.screenshot(path=str(artifacts/'01-admin-account-header.png'),full_page=True)
  check('administrator header has one complete colored role badge, My Account and an accessible logout icon; account page retains the username')

  project=api(context,'POST','/dramas',{'title':'UI modal layout '+suffix,'style':'','aspect_ratio':'16:9'})
  episode=api(context,'POST','/episodes',{'drama_id':project['id'],'title':'布局验收集'})
  identity=context.request.get(args.url+'/api/v1/auth/me').json()['data']
  upload=context.request.post(args.url+'/api/v1/upload/image',headers={'X-CSRF-Token':identity['csrfToken'],'X-Project-ID':str(project['id'])},multipart={'file':{'name':'synthetic-portrait.png','mimeType':'image/png','buffer':png()}})
  assert upload.ok,upload.status
  image_path=upload.json()['data']['path']
  chars=[];scenes=[];props=[]
  for index in range(4):
   item=api(context,'POST','/characters',{'drama_id':project['id'],'episode_id':episode['id'],'name':f'布局角色 {index+1}','appearance':'只用于界面布局的合成描述。','styling':'测试服装。'})
   api(context,'PUT',f'/characters/{item["id"]}',{'image_url':image_path,'local_path':image_path,'final_prompt':'合成角色提示词，界面验收不发送模型。'})
   chars.append(item)
  for index in range(10):
   item=api(context,'POST','/scenes',{'drama_id':project['id'],'episode_id':episode['id'],'location':f'布局场景 {index+1}','time':'白天','prompt':'只用于界面布局的合成场景。','lighting':'柔和自然光。'})
   api(context,'PUT',f'/scenes/{item["id"]}',{'image_url':image_path,'local_path':image_path,'final_prompt':'合成场景提示词，界面验收不发送模型。'})
   scenes.append(item)
  for index in range(30):
   item=api(context,'POST','/props',{'drama_id':project['id'],'episode_id':episode['id'],'name':f'布局道具 {index+1:02d}','type':'测试道具','description':'只用于界面布局的合成道具描述。'})
   api(context,'PUT',f'/props/{item["id"]}',{'image_url':image_path,'local_path':image_path,'final_prompt':'\n'.join(f'第 {line+1} 行：合成测试提示词，不发送模型。' for line in range(35))})
   props.append(item)
  page.goto(args.url+f'/drama/{project["id"]}');page.locator('.page-tabs button').filter(has_text='素材库').click()
  expect(page.locator('.prop-card')).to_have_count(30)
  page.set_viewport_size({'width':1366,'height':620})
  previous=scrolled_bottom(page)
  page.locator('.prop-card').last.locator('.asset-final').click()
  dialog=edit_bounds(page,'last prop editor after project scroll >1000')
  stable_background(page,previous)
  body=dialog.locator('.mat-detail-body')
  measurements.append({'label':'editor internal scroll dimensions','dimensions':body.evaluate('(element)=>({clientHeight:element.clientHeight,scrollHeight:element.scrollHeight,overflow:getComputedStyle(element).overflowY})')})
  body.hover(position={'x':8,'y':12});page.mouse.wheel(0,900);page.wait_for_timeout(180)
  assert body.evaluate('(element)=>element.scrollTop')>0,'The long editor must scroll internally.'
  stable_background(page,previous)
  page.mouse.move(10,380);page.mouse.wheel(0,1600);page.wait_for_timeout(180);stable_background(page,previous)
  page.screenshot(path=str(artifacts/'02-last-prop-editor-contained.png'),full_page=True)
  close_edit(page,previous)
  check('after a real deep inner-page scroll, clicking the last prop final prompt opens a viewport-contained body-teleported editor; wheel scrolling never moves the project and close restores its position')

  page.locator('.prop-card').last.locator('.asset-name').click();dialog=edit_bounds(page,'nested portrait editor')
  dialog.locator('.mat-detail-media-frame').click();viewer=page.locator('.viewer-dialog');within_viewport(page,viewer,'nested portrait viewer')
  image=viewer.locator('.viewer-img');expect(image).to_be_visible();page.wait_for_function("()=>{const image=document.querySelector('.viewer-img');return image?.complete&&image.naturalHeight===1600}")
  within_viewport(page,image,'nested portrait image')
  assert image.evaluate('(element)=>element.naturalWidth===320&&element.naturalHeight===1600')
  assert image.evaluate('(element)=>getComputedStyle(element).objectFit')=='contain'
  measurements.append({'label':'portrait original ratio','naturalWidth':320,'naturalHeight':1600,'aspectRatio':0.2,'objectFit':'contain'})
  page.screenshot(path=str(artifacts/'03-nested-portrait-preview.png'),full_page=True)
  page.keyboard.press('Escape');expect(page.locator('.viewer-dialog')).to_have_count(0);expect(page.locator('.mat-detail-dialog')).to_be_visible();stable_background(page,previous)
  close_edit(page,previous)
  page.locator('.prop-card').last.locator('.previewable-image').click();within_viewport(page,page.locator('.viewer-dialog'),'standalone portrait viewer');page.keyboard.press('Escape');expect(page.locator('.viewer-dialog')).to_have_count(0);stable_background(page,previous)
  check('portrait preview fits the viewport with its original aspect ratio; nested Escape returns to the still-open editor and standalone preview restores the original project scroll')

  for selector,label in [('.character-asset-card','character editor'),('.asset-click-card:not(.prop-card)','scene editor')]:
   target=page.locator(selector).last;target.scroll_into_view_if_needed();before=page.locator('.page').evaluate('(element)=>element.scrollTop');target.locator('.character-name' if 'character' in selector else '.asset-name').click();edit_bounds(page,label);close_edit(page,before)
  check('character and scene editors share the same viewport containment and background-scroll preservation')

  page.set_viewport_size({'width':390,'height':844});previous=scrolled_bottom(page)
  page.locator('.prop-card').last.locator('.asset-final').click();dialog=edit_bounds(page,'mobile last prop editor')
  assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
  dialog.locator('.mat-detail-media-frame').click();within_viewport(page,page.locator('.viewer-dialog'),'mobile portrait viewer');within_viewport(page,page.locator('.viewer-img'),'mobile portrait image')
  page.screenshot(path=str(artifacts/'04-mobile-portrait-preview.png'),full_page=True)
  page.keyboard.press('Escape');expect(page.locator('.mat-detail-dialog')).to_be_visible()
  page.screenshot(path=str(artifacts/'05-mobile-editor-close-reachable.png'),full_page=True)
  close_edit(page,previous)
  check('mobile portrait preview and editor fit a 390px viewport, keep close actions reachable and retain the deep project position')

  page.set_viewport_size({'width':1366,'height':768});page.locator('.page').evaluate('(element)=>element.scrollTop=0')
  page.locator('.head-action').click();within_viewport(page,page.locator('.ep-dialog'),'new episode dialog')
  assert page.locator('.ep-dialog').locator('..').evaluate('(element)=>element.parentElement===document.body')
  page.locator('.ep-dialog .dialog-close').click();expect(page.locator('.ep-dialog')).to_have_count(0)
  stable_background(page,0)
  page.get_by_role('button',name='模型参数',exact=True).click();within_viewport(page,page.locator('.project-parameter-dialog'),'project model parameters')
  assert page.locator('.project-parameter-dialog').locator('..').evaluate('(element)=>element.parentElement===document.body')
  page.locator('.project-parameter-dialog').get_by_role('button',name='完成',exact=True).click();expect(page.locator('.project-parameter-dialog')).to_have_count(0)
  page.goto(args.url+f'/drama/{project["id"]}/episode/{episode["episode_number"]}')
  expect(page.locator('.studio-topbar')).to_be_visible();expect(page.locator('.studio-topbar .task-drawer-trigger')).to_have_count(0);expect(page.locator('.studio-topbar .task-center-launcher')).to_have_count(1)
  compact_account(page,'管理员','admin');page.screenshot(path=str(artifacts/'06-episode-no-duplicate-tasks.png'),full_page=True)
  page.set_viewport_size({'width':1920,'height':1080});page.wait_for_timeout(100);compact_account(page,'管理员','admin')
  main_box=page.locator('.studio-topbar-main').bounding_box();side_box=page.locator('.studio-topbar-side').bounding_box()
  assert side_box['x']>=main_box['x']+main_box['width']-1 and max(main_box['y'],side_box['y'])<min(main_box['y']+main_box['height'],side_box['y']+side_box['height']),{'main':main_box,'side':side_box}
  measurements.append({'label':'1920 episode header keeps one row','main':main_box,'side':side_box})
  page.screenshot(path=str(artifacts/'08-wide-episode-single-row.png'),full_page=True)
  page.set_viewport_size({'width':390,'height':844});page.wait_for_timeout(100);compact_account(page,'管理员','admin')
  page.screenshot(path=str(artifacts/'09-mobile-episode-account-reachable.png'),full_page=True)
  check('project parameters and new-episode dialogs are body-teleported; the episode header retains AI live logs while removing only the duplicate task entry')

  user=browser.new_context(viewport={'width':1366,'height':768},locale='zh-CN');user.add_init_script("for(let id=1;id<1000;id++)localStorage.setItem(`huobao:user:${id}:huobao:tours`,JSON.stringify(['index','detail','episode']));")
  userpage=user.new_page();userpage.on('pageerror',lambda error:errors.append(str(error)));username='ui-layout-user-'+suffix
  userpage.goto(args.url+'/register');userpage.get_by_label('用户名',exact=True).fill(username);userpage.get_by_label('密码',exact=True).fill('x');userpage.get_by_label('再次输入密码',exact=True).fill('x');userpage.get_by_role('button',name='注册并进入工作台',exact=True).click();userpage.wait_for_url(args.url+'/')
  compact_account(userpage,'用户',username);expect(userpage.locator('a[href="/admin/channels"]')).to_have_count(0)
  userpage.get_by_role('link',name='我的账户与修改密码',exact=True).click();expect(userpage.locator('.account-info>p')).to_have_attribute('title',username)
  userpage.screenshot(path=str(artifacts/'07-user-account-header.png'),full_page=True)
  userpage.get_by_role('button',name='退出登录',exact=True).click();userpage.wait_for_url(args.url+'/login')
  check('ordinary user sees one complete User badge with My Account and logout, sees the full username on its own account page, and logout remains functional')
  assert not errors,errors
  assert not generation_requests,generation_requests
  browser.close()
 result={'passed':len(checks),'checks':checks,'page_errors':errors,'paid_requests':0,'generation_requests':generation_requests,'material_count':44,'project_id':project['id'],'measurements':measurements}
 (artifacts/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),'utf-8')
 print(json.dumps({'passed':len(checks),'page_errors':len(errors),'paid_requests':0,'materials':44,'artifacts':str(artifacts)},ensure_ascii=False))
except Exception:
 (artifacts/'failure-context.json').write_text(json.dumps({'checks':checks,'page_errors':errors,'generation_requests':generation_requests,'measurements':measurements},ensure_ascii=False,indent=2),'utf-8')
 raise
