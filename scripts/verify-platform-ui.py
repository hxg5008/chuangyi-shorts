"""Exercise the real platform UI against an explicitly isolated, local test database.

No upstream generation/connection-test endpoint is called. Test credentials stay in memory.
"""
import argparse
import datetime as dt
import json
import pathlib
import re
import sqlite3
import uuid
from playwright.sync_api import sync_playwright, expect


parser = argparse.ArgumentParser()
parser.add_argument('--url', default='http://127.0.0.1:15679')
parser.add_argument('--test-root', required=True)
parser.add_argument('--artifacts', required=True)
args = parser.parse_args()
root = pathlib.Path(args.test_root).resolve()
assert root.name.startswith('huobao-platform-integration-'), 'Only a dedicated platform integration directory is allowed.'
assert args.url.startswith('http://127.0.0.1:15679'), 'Only the isolated local test port is allowed.'
artifacts = pathlib.Path(args.artifacts).resolve()
artifacts.mkdir(parents=True, exist_ok=True)
credentials = (root / 'admin-initial-password.txt').read_text('utf-8')
admin_password = re.search(r'^Initial password: (.+)$', credentials, re.M).group(1).strip()
suffix = uuid.uuid4().hex[:7]
creator = 'ui_creator_' + suffix
other = 'ui_other_' + suffix
password = 'UiTestOnly!8-' + suffix
checks = []
errors = []


def check(label):
    checks.append(label)


def seed_activity(project_id, user_id):
    db = sqlite3.connect(root / 'test.sqlite3', timeout=15)
    now = dt.datetime.now(dt.timezone.utc)
    created = (now - dt.timedelta(seconds=94)).isoformat()
    finished = (now - dt.timedelta(seconds=25)).isoformat()
    rows = [('text', '提取角色与场景', 'completed', 'completed', 'gpt-test', None),
            ('image', '角色 · 林知夏', 'completed', 'completed', 'image-test', None),
            ('video', '分镜 01 · 清晨维修间', 'running', 'polling', 'video-test', {'progress': 47}),
            ('video', '分镜 02 · 上游失败示例', 'failed', 'failed', 'video-test', None),
            ('image', '场景 · 小工厂', 'queued', 'queued', 'image-test', None)]
    for kind, title, status, stage, model, result in rows:
        task_id = f'ui-{suffix}-{kind}-{status}'
        request = {'messages': [{'role': 'user', 'content': '请提取本集人物与场景。'}], 'system': 'TEST ADMIN ONLY SNAPSHOT'}
        output = '已提取 3 位角色与 2 个场景，并保存到本集资产库。\n人物：林知夏、许安、陈师傅。\n场景：清晨维修间、社区礼堂。' if kind == 'text' else None
        error = '参考素材检查未通过，请调整后再提交。' if status == 'failed' else None
        db.execute('''INSERT INTO platform_activity_tasks(id,user_id,project_id,kind,title,status,stage,model,channel,request_json,output_json,usage_json,result_json,error,created_at,started_at,finished_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
            (task_id,user_id,project_id,kind,title,status,stage,model,'UI 验收渠道',json.dumps(request),json.dumps(output),json.dumps({'input_tokens':1234,'output_tokens':567}) if kind=='text' else None,json.dumps(result),error,created,created,finished if status in ['completed','failed'] else None,created))
        db.execute('INSERT INTO platform_activity_events(task_id,kind,message,payload_json,created_at) VALUES(?,?,?,?,?)', (task_id,'submitted','已提交模型处理。','{}',created))
        db.execute('INSERT INTO platform_activity_events(task_id,kind,message,payload_json,created_at) VALUES(?,?,?,?,?)', (task_id,'failed' if error else 'saved' if status=='completed' else 'polling',error or '任务阶段已更新。','{}',finished))
        if kind == 'text':
            db.execute('INSERT INTO platform_activity_rounds(id,task_id,number,model,provider,status,input_json,output_json,usage_json,created_at,finished_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', (f'round-{suffix}',task_id,1,model,'UI 验收渠道','completed',json.dumps(request),json.dumps(output),json.dumps({'input_tokens':1234,'output_tokens':567}),created,finished))
    db.commit()
    db.close()


def login(page, username, secret):
    page.goto(args.url + '/login')
    page.get_by_label('用户名', exact=True).fill(username)
    page.get_by_label('密码', exact=True).fill(secret)
    page.get_by_role('button', name='进入工作台').click()
    page.wait_for_url(lambda url: '/login' not in url)


def session(context):
    response = context.request.get(args.url + '/api/v1/auth/me')
    assert response.ok
    return response.json()['data']


with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe', headless=True)
    context = browser.new_context(viewport={'width':1440,'height':1000}, locale='zh-CN')
    context.add_init_script("for(let id=1;id<200;id++)localStorage.setItem(`huobao:user:${id}:huobao:tours`,JSON.stringify(['index','detail','episode']));")
    page = context.new_page()
    page.on('pageerror', lambda err: errors.append(str(err)))
    page.goto(args.url + '/login')
    expect(page.get_by_role('heading', name='登录，继续你的创作')).to_be_visible()
    page.screenshot(path=str(artifacts/'01-login.png'), full_page=True)
    login(page,'admin',admin_password)
    check('real admin login through session cookie')
    page.goto(args.url + '/admin/users')
    expect(page.get_by_role('heading', name='用户与权限', exact=True)).to_be_visible()
    for username, display in [(creator,'创作者 A'),(other,'创作者 B')]:
        page.get_by_role('button', name='添加用户', exact=True).click()
        dialog = page.get_by_role('dialog').filter(has=page.get_by_role('heading',name='添加创作者'))
        dialog.get_by_label('用户名',exact=True).fill(username)
        dialog.get_by_label('显示名称',exact=True).fill(display)
        dialog.get_by_label('初始密码').fill(password)
        dialog.get_by_role('button',name='创建账号',exact=True).click()
        page.get_by_role('button',name='已妥善保存',exact=True).click()
        expect(page.locator('.user-table tr').filter(has_text=username).get_by_text(display,exact=True)).to_be_visible()
    page.screenshot(path=str(artifacts/'02-user-admin.png'),full_page=True)
    check('two creators created from actual admin UI, one-time credential dialog dismissed')
    page.goto(args.url + '/admin/channels')
    page.get_by_role('button',name='添加渠道',exact=True).first.click()
    dialog = page.get_by_role('dialog')
    dialog.get_by_label('渠道名称').fill('UI 验收渠道 ' + suffix)
    dialog.get_by_label('API URL').fill('http://127.0.0.1:1')
    dialog.get_by_label('API Key',exact=False).fill('ui-test-placeholder-not-a-real-key')
    dialog.get_by_role('button',name='保存渠道',exact=True).click()
    expect(page.locator('.channel-detail-title h2')).to_have_text('UI 验收渠道 ' + suffix)
    page.get_by_role('button',name='添加模型',exact=True).first.click()
    dialog = page.get_by_role('dialog')
    dialog.get_by_label('模型类型',exact=True).select_option('text')
    dialog.get_by_label('显示名称').fill('UI 文字模型')
    dialog.get_by_label('上游模型 ID').fill('ui-text-model')
    dialog.get_by_label('请求协议').select_option('text.openai-chat')
    dialog.get_by_role('button',name='保存模型',exact=True).click()
    expect(page.locator('.channel-table').get_by_text('UI 文字模型',exact=True)).to_be_visible()
    page.screenshot(path=str(artifacts/'03-channel-admin.png'),full_page=True)
    check('channel + text binding saved through actual admin forms without upstream requests')
    page.get_by_role('button',name='添加模型',exact=True).first.click()
    dialog = page.get_by_role('dialog')
    dialog.get_by_label('模型类型',exact=True).select_option('video')
    dialog.get_by_label('显示名称').fill('UI 视频模型')
    dialog.get_by_label('上游模型 ID').fill('ui-video-model')
    dialog.get_by_label('请求协议').select_option('video.minimax')
    dialog.get_by_label('参考图片上限').fill('3')
    dialog.get_by_label('可选时长（秒）').fill('5, 10, 15')
    dialog.get_by_label('分辨率',exact=True).fill('720p, 1080p')
    dialog.get_by_label('画面比例').fill('16:9, 9:16')
    dialog.get_by_label('上游模型 ID').click()
    page.screenshot(path=str(artifacts/'04-model-editor.png'),full_page=True)
    dialog.get_by_role('button',name='保存模型',exact=True).click()
    expect(page.locator('.channel-table').get_by_text('UI 视频模型',exact=True)).to_be_visible()
    check('typed video capabilities stored with independent protocol and permissions')
    creator_context = browser.new_context(viewport={'width':1440,'height':1000},locale='zh-CN')
    creator_context.add_init_script("for(let id=1;id<200;id++)localStorage.setItem(`huobao:user:${id}:huobao:tours`,JSON.stringify(['index','detail','episode']));")
    creator_page = creator_context.new_page()
    creator_page.on('pageerror',lambda err: errors.append(str(err)))
    login(creator_page,creator,password)
    expect(creator_page.locator('a[href="/admin/channels"]')).to_have_count(0)
    expect(creator_page.locator('a[href="/settings"]')).to_have_count(0)
    creator_page.goto(args.url + '/admin/channels')
    creator_page.wait_for_url(args.url + '/')
    check('creator navigation hides admin/settings and direct admin URL is redirected')
    creator_page.get_by_role('button',name='新建项目',exact=True).first.click()
    creator_page.locator('.create-dialog input').fill('UI 私有项目 ' + suffix)
    creator_page.locator('.create-dialog button[type="submit"]').click()
    creator_page.wait_for_url(re.compile(r'/drama/\d+$'))
    project_id = int(creator_page.url.rsplit('/',1)[1])
    user = session(creator_context)['user']
    seed_activity(project_id,user['id'])
    check('creator created private project via unchanged original creation dialog')
    creator_page.goto(args.url + '/tasks')
    expect(creator_page.get_by_text('提取角色与场景',exact=True).first).to_be_visible()
    creator_page.get_by_role('button').filter(has=creator_page.get_by_text('提取角色与场景',exact=True)).first.click()
    expect(creator_page.locator('.activity-output-box')).to_contain_text('已提取 3 位角色')
    creator_page.screenshot(path=str(artifacts/'05-task-center-output.png'),full_page=True)
    creator_page.get_by_role('button',name='提交内容',exact=True).click()
    expect(creator_page.locator('.activity-code-box')).not_to_contain_text('TEST ADMIN ONLY SNAPSHOT')
    check('creator task detail renders real output and server removes administrator-only system snapshot')
    creator_page.get_by_role('button').filter(has=creator_page.get_by_text('分镜 01 · 清晨维修间',exact=True)).first.click()
    expect(creator_page.locator('.activity-progress')).to_contain_text('47%')
    creator_page.screenshot(path=str(artifacts/'06-task-center-progress.png'),full_page=True)
    creator_page.get_by_role('button',name=re.compile(r'^失败')).click()
    expect(creator_page.locator('.activity-item')).to_have_count(1)
    expect(creator_page.locator('.activity-failure')).to_contain_text('参考素材检查未通过')
    check('actual progress uses stored upstream percent; failure filter and actual error agree')
    creator_page.set_viewport_size({'width':390,'height':844})
    creator_page.screenshot(path=str(artifacts/'07-task-center-mobile.png'),full_page=True)
    assert creator_page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
    other_context=browser.new_context()
    other_page=other_context.new_page()
    login(other_page,other,password)
    read=other_context.request.get(args.url + '/api/v1/dramas')
    assert all(row['id']!=project_id for row in read.json()['data']['items'])
    assert other_context.request.get(args.url + f'/api/v1/dramas/{project_id}').status in (403,404)
    assert other_context.request.get(args.url + '/api/v1/activity/tasks').json()['data']['total']==0
    assert other_context.request.get(args.url + '/api/v1/admin/channels').status==403
    safe_models=other_context.request.get(args.url + '/api/v1/ai-configs').json()['data']
    assert all(not row.get('api_key') and not row.get('base_url') for row in safe_models)
    check('second real login cannot see/open another creator project/tasks or channel secrets')
    creator_page.get_by_title('退出登录').click()
    creator_page.wait_for_url(re.compile(r'/login'))
    check('logout clears local actor state and returns to login')
    browser.close()

assert not errors, 'Browser page errors encountered (details in private QA report).'
result={'passed':len(checks),'checks':checks,'browser_page_errors':errors,'upstream_requests_submitted':0,'test_only_project_id':project_id}
(artifacts/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),'utf-8')
print(json.dumps({'passed':len(checks),'browser_page_errors':len(errors),'upstream_requests_submitted':0,'artifacts':str(artifacts)},ensure_ascii=False))
