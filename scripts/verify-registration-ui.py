"""UI-only account and deletion acceptance on an isolated local fixture; never invokes models."""
import argparse,json,pathlib,re,uuid
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright,expect

parser=argparse.ArgumentParser()
parser.add_argument('--url',default='http://127.0.0.1:15679')
parser.add_argument('--test-root',required=True)
parser.add_argument('--artifacts',required=True)
parser.add_argument('--skip-delete',action='store_true')
parser.add_argument('--delete-only',action='store_true')
args=parser.parse_args()
root=pathlib.Path(args.test_root).resolve();assert root.name.startswith('huobao-platform-registration-')
address=urlparse(args.url);assert address.hostname=='127.0.0.1' and address.scheme=='http'
artifacts=pathlib.Path(args.artifacts).resolve();artifacts.mkdir(parents=True,exist_ok=True)
initial=root/'admin-initial-password.txt'
short_password='1'
admin_password=re.search(r'^Initial password: (.+)$',initial.read_text('utf-8'),re.M).group(1).strip() if initial.exists() else short_password
suffix=uuid.uuid4().hex[:8]
short_name=chr(0x4e00+(int(suffix,16)%20000))
long_name='长用户名_'+suffix+'_'+('名'*110)
long_password='  '+('p'*330)+'_'+suffix+' 密码尾部  '
checks=[];page_errors=[]
def check(label):checks.append(label)
def me(context):
    response=context.request.get(args.url+'/api/v1/auth/me');assert response.ok
    return response.json()['data']
def api(context,method,path,body=None):
    identity=me(context)
    response=context.request.fetch(args.url+'/api/v1'+path,method=method,data=body,headers={'X-CSRF-Token':identity['csrfToken']})
    value=response.json();assert response.ok and value.get('code',200)<400,(method,path,response.status,value.get('message'))
    return value.get('data',value)
def login(page,name,password):
    page.goto(args.url+'/login');page.get_by_label('用户名',exact=True).fill(name);page.get_by_label('密码',exact=True).fill(password)
    page.get_by_role('button',name='进入工作台',exact=True).click();page.wait_for_url(args.url+'/')
def register(page,name,password):
    page.goto(args.url+'/register');page.get_by_label('用户名',exact=True).fill(name);page.get_by_label('密码',exact=True).fill(password);page.get_by_label('再次输入密码',exact=True).fill(password)
    for label in ['用户名','密码','再次输入密码']:
        assert page.get_by_label(label,exact=True).evaluate('(element)=>element.maxLength===-1&&element.minLength===-1')
    with page.expect_response(lambda response:response.request.method=='POST' and response.url.endswith('/api/v1/auth/register')) as registered:
        page.get_by_role('button',name='注册并进入工作台',exact=True).click()
    assert registered.value.ok,registered.value.status
    page.wait_for_url(args.url+'/')

try:
 with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',headless=True)
    context=browser.new_context(viewport={'width':1440,'height':1000},locale='zh-CN')
    context.add_init_script("for(let id=1;id<200;id++)localStorage.setItem(`huobao:user:${id}:huobao:tours`,JSON.stringify(['index','detail','episode']));")
    page=context.new_page();page.on('pageerror',lambda error:page_errors.append(str(error)))
    if not args.delete_only:
        page.goto(args.url+'/login')
        assert 'admin-initial-password.txt' not in page.locator('body').inner_text()
        assert '管理员分配' not in page.locator('body').inner_text()
        page.get_by_role('button',name='重新检查连接',exact=True).click()
        expect(page.locator('.login-status')).to_contain_text('服务已连接')
        expect(page.locator('.login-error')).to_have_count(0)
        page.screenshot(path=str(artifacts/'01-public-login.png'),full_page=True)
        page.get_by_role('link',name='立即注册',exact=True).click();page.wait_for_url(args.url+'/register')
        expect(page.get_by_role('heading',name='创建你的创作账号')).to_be_visible()
        assert 'admin-initial-password.txt' not in page.locator('body').inner_text()
        page.screenshot(path=str(artifacts/'02-self-registration.png'),full_page=True)
        register(page,short_name,short_password)
        identity=me(context);assert identity['user']['username']==short_name and identity['user']['role']=='user'
        assert context.request.get(args.url+'/api/v1/admin/users').status==403
        expect(page.locator('a[href="/admin/channels"]')).to_have_count(0)
        page.goto(args.url+'/admin/channels');page.wait_for_url(args.url+'/')
        check('one-character Unicode username and password register through real UI, auto-login as user, and cannot enter administration')
        project=api(context,'POST','/dramas',{'title':'Registration private '+suffix,'style':'','aspect_ratio':'16:9'})
        second=browser.new_context(viewport={'width':1440,'height':1000},locale='zh-CN')
        second.add_init_script("for(let id=1;id<200;id++)localStorage.setItem(`huobao:user:${id}:huobao:tours`,JSON.stringify(['index','detail','episode']));")
        second_page=second.new_page();second_page.on('pageerror',lambda error:page_errors.append(str(error)))
        register(second_page,long_name,long_password)
        identity=me(second);assert identity['user']['username']==long_name
        assert not any(item['id']==project['id'] for item in api(second,'GET','/dramas')['items'])
        assert second.request.get(args.url+f'/api/v1/dramas/{project["id"]}').status in (403,404)
        second_page.get_by_title('退出登录',exact=True).click();second_page.wait_for_url(args.url+'/login')
        login(second_page,long_name,long_password);assert me(second)['user']['username']==long_name
        second_page.get_by_role('link',name='我的账户与修改密码',exact=True).click()
        expect(second_page.get_by_role('heading',name='我的账号',exact=True)).to_be_visible()
        assert second_page.locator('.account-info>p').get_attribute('title')==long_name
        assert second_page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
        second_page.screenshot(path=str(artifacts/'03-long-name-account.png'),full_page=True)
        second_page.set_viewport_size({'width':390,'height':844})
        assert second_page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
        assert second_page.locator('.account-grid').evaluate('(element)=>element.scrollWidth<=element.clientWidth+1')
        assert second_page.locator('.account-info').evaluate('(element)=>element.getBoundingClientRect().right<=innerWidth+1')
        second_page.screenshot(path=str(artifacts/'04-mobile-account.png'),full_page=True)
        check('username over 60 and password over 256 including leading/trailing spaces register and log in verbatim, with isolated projects and no horizontal overflow')
        duplicate=browser.new_context();duplicate_page=duplicate.new_page();duplicate_page.goto(args.url+'/register')
        duplicate_page.get_by_label('用户名',exact=True).fill(short_name);duplicate_page.get_by_label('密码',exact=True).fill(short_password);duplicate_page.get_by_label('再次输入密码',exact=True).fill(short_password)
        with duplicate_page.expect_response(lambda response:response.request.method=='POST' and response.url.endswith('/api/v1/auth/register')) as response:
            duplicate_page.get_by_role('button',name='注册并进入工作台',exact=True).click()
        assert response.value.status==409
        expect(duplicate_page.locator('.login-error')).to_be_visible()
        check('duplicate registration produces a real conflict without changing the guest into another user')
    admin=browser.new_context(viewport={'width':1440,'height':1000},locale='zh-CN')
    admin.add_init_script("for(let id=1;id<200;id++)localStorage.setItem(`huobao:user:${id}:huobao:tours`,JSON.stringify(['index','detail','episode']));")
    admin_page=admin.new_page();admin_page.on('pageerror',lambda error:page_errors.append(str(error)))
    login(admin_page,'admin',admin_password)
    if not args.delete_only:
        old=browser.new_context();old_page=old.new_page();login(old_page,'admin',admin_password)
        admin_page.get_by_role('link',name='我的账户与修改密码',exact=True).click()
        expect(admin_page.get_by_role('heading',name='修改密码',exact=True)).to_be_visible()
        for label in ['当前密码','新密码','再次输入新密码']:
            assert admin_page.get_by_label(label,exact=True).evaluate('(element)=>element.maxLength===-1&&element.minLength===-1')
        admin_page.get_by_label('当前密码',exact=True).fill(admin_password);admin_page.get_by_label('新密码',exact=True).fill(short_password);admin_page.get_by_label('再次输入新密码',exact=True).fill(short_password)
        with admin_page.expect_response(lambda response:response.request.method=='POST' and response.url.endswith('/api/v1/auth/change-password')) as response:
            admin_page.get_by_role('button',name='更新密码',exact=True).click()
        assert response.value.ok
        expect(admin_page.get_by_label('当前密码',exact=True)).to_have_value('')
        assert me(admin)['user']['role']=='admin'
        assert old.request.get(args.url+'/api/v1/auth/me').status==401
        admin_page.get_by_title('退出登录',exact=True).click();admin_page.wait_for_url(args.url+'/login')
        login(admin_page,'admin',short_password)
        admin_page.get_by_role('link',name='我的账户与修改密码',exact=True).click()
        admin_page.screenshot(path=str(artifacts/'05-admin-password-account.png'),full_page=True)
        check('administrator finds My Account, changes to one-character password, retains the rotated session and invalidates other old sessions; new password logs in')
        admin_page.goto(args.url+'/admin/users');admin_page.get_by_role('button',name='添加用户',exact=True).click()
        dialog=admin_page.get_by_role('dialog').filter(has=admin_page.get_by_role('heading',name='添加创作者'))
        created_name='管理员创建_'+suffix+'_'+('长'*100)
        dialog.get_by_label('用户名',exact=True).fill(created_name);dialog.get_by_label('初始密码',exact=False).fill('x')
        for label in ['用户名','初始密码']:
            assert dialog.get_by_label(label,exact=False).evaluate('(element)=>element.maxLength===-1&&element.minLength===-1')
        dialog.get_by_role('button',name='创建账号',exact=True).click();admin_page.get_by_role('button',name='已妥善保存',exact=True).click()
        expect(admin_page.locator('.user-table tr').filter(has_text=created_name)).to_be_visible()
        assert admin_page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
        admin_page.screenshot(path=str(artifacts/'06-admin-long-name-table.png'),full_page=True)
        check('administrator can create long usernames and short passwords without implicit display-name limits or page overflow')
    if not args.skip_delete:
        channel=api(admin,'POST','/admin/channels',{'name':'UI delete '+suffix,'base_url':'http://127.0.0.1:1','enabled':True})
        binding=api(admin,'POST',f'/admin/channels/{channel["id"]}/models',{'name':'UI delete model '+suffix,'model':'ui-delete-'+suffix,'type':'image','protocol_id':'image.openai','enabled':True,'access':'all'})
        admin_page.on('dialog',lambda dialog:dialog.accept())
        admin_page.goto(args.url+'/admin/channels');admin_page.locator('.channel-card').filter(has_text='UI delete '+suffix).click()
        row=admin_page.locator('.channel-table tr').filter(has_text='UI delete model '+suffix)
        expect(row).to_be_visible();row.get_by_title('删除模型',exact=True).click();expect(row).to_have_count(0)
        assert not any(item['id']==binding['id'] for item in api(admin,'GET',f'/admin/channels/{channel["id"]}/models'))
        admin_page.reload();expect(admin_page.locator('.channel-table tr').filter(has_text='UI delete model '+suffix)).to_have_count(0)
        assert not any(item['id']==binding['config_id'] for item in api(admin,'GET','/ai-configs'))
        admin_page.locator('.channel-tools').get_by_title('删除渠道',exact=True).click()
        expect(admin_page.locator('.channel-card').filter(has_text='UI delete '+suffix)).to_have_count(0)
        admin_page.reload();expect(admin_page.locator('.channel-card').filter(has_text='UI delete '+suffix)).to_have_count(0)
        admin_page.screenshot(path=str(artifacts/'07-real-delete-removed.png'),full_page=True)
        check('real model and channel DELETE remove rows, counts and selectable models permanently across reloads')
    assert not page_errors,page_errors
    browser.close()
 result={'checks':checks,'passed':len(checks),'page_errors':page_errors,'model_requests':0,'paid_requests':0,'tested_long_username_characters':len(long_name),'tested_long_password_characters':len(long_password),'delete_checked':not args.skip_delete}
 name='delete-result.json' if args.delete_only else 'registration-result.json'
 (artifacts/name).write_text(json.dumps(result,ensure_ascii=False,indent=2),'utf-8')
 print(json.dumps({'passed':len(checks),'page_errors':len(page_errors),'model_requests':0,'delete_checked':not args.skip_delete,'artifacts':str(artifacts)},ensure_ascii=False))
except Exception:
 (artifacts/'registration-failure-context.json').write_text(json.dumps({'completed_checks':checks,'page_errors':page_errors,'model_requests':0},ensure_ascii=False,indent=2),'utf-8')
 raise
