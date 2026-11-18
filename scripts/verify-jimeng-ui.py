"""Isolated browser QA: temporary SQLite/workspace, fake catalog, no generation requests."""
from __future__ import annotations
import base64
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import threading
import time
import urllib.request
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
ARTIFACT = ROOT.parent / "deployments" / ("huobao-jimeng-ui-" + time.strftime("%Y%m%d-%H%M%S"))
ARTIFACT.mkdir(parents=True, exist_ok=False)
CALLS = []


class FakeCatalog(BaseHTTPRequestHandler):
    def log_message(self, *_args): pass
    def do_GET(self):
        CALLS.append(("GET", self.path))
        if self.path == "/v1/models":
            payload = {"service": "jimeng-local-service", "version": "ui-test", "object": "list", "data": [{"id": "jimeng-2.0-fast", "owned_by": "local-adapter"}]}
        elif self.path == "/v1/status":
            payload = {"service": "jimeng-local-service", "active": 0, "queued": 0}
        else:
            self.send_error(404); return
        content = json.dumps(payload).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(content))); self.end_headers(); self.wfile.write(content)
    def do_POST(self):
        CALLS.append(("POST", self.path)); self.send_error(405, "UI verification never generates")


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0)); return s.getsockname()[1]


def request(origin, path, data=None):
    req = urllib.request.Request(origin + "/api/v1" + path, data=None if data is None else json.dumps(data, ensure_ascii=False).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as response:
        payload = json.load(response)
    if payload.get("code", 200) >= 400: raise RuntimeError(payload)
    return payload.get("data", payload)


def insert(db, table, **fields):
    keys = list(fields)
    query = f"INSERT INTO {table} ({','.join(keys)}) VALUES ({','.join('?' for _ in keys)})"
    return db.execute(query, [fields[key] for key in keys]).lastrowid


@contextmanager
def connect_database(database):
    db = sqlite3.connect(database)
    try:
        yield db
        db.commit()
    finally:
        db.close()


def main():
    catalog = ThreadingHTTPServer(("127.0.0.1", 0), FakeCatalog)
    threading.Thread(target=catalog.serve_forever, daemon=True).start()
    catalog_origin = f"http://127.0.0.1:{catalog.server_port}"
    port = free_port(); origin = f"http://127.0.0.1:{port}"
    errors = []
    with tempfile.TemporaryDirectory(prefix="huobao-jimeng-ui-") as temp:
        temp = Path(temp); storage = temp / "static"; storage.mkdir()
        workspace = temp / "workspace"; shutil.copytree(ROOT / "backend" / "workspace", workspace)
        database = temp / "ui.sqlite3"
        env = {**os.environ, "HOST": "127.0.0.1", "PORT": str(port), "SQLITE_PATH": str(database), "HUOBAO_DATA_DIR": str(temp), "WORKSPACE_PATH": str(workspace), "FRONTEND_DIST": str(ROOT / "frontend" / ".output" / "public")}
        for key in list(env):
            if key.startswith("MYSQL_"): env.pop(key)
        node = shutil.which("node"); assert node
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        with (ARTIFACT / "backend.log").open("w", encoding="utf-8") as log:
            proc = subprocess.Popen([node, "--import", (ROOT / "backend" / "node_modules" / "tsx" / "dist" / "loader.mjs").as_uri(), "src/index.ts"], cwd=ROOT / "backend", env=env, stdout=log, stderr=subprocess.STDOUT, creationflags=flags)
            try:
                for _ in range(150):
                    if proc.poll() is not None: raise RuntimeError("Isolated backend exited; inspect backend.log")
                    try:
                        request(origin, "/health"); break
                    except Exception: time.sleep(.2)
                else: raise RuntimeError("Isolated backend did not start")
                image = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf9sAAAAASUVORK5CYII=")
                (storage / "asset.png").write_bytes(image)
                subprocess.run([str(ROOT / "backend" / "node_modules" / "ffmpeg-static" / "ffmpeg.exe"), "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=gray:s=320x180:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(storage / "old.mp4")], check=True, creationflags=flags)
                ts = "2026-11-05T01:00:00.000Z"
                with connect_database(database) as db:
                    cfg = insert(db, "ai_service_configs", service_type="video", provider="jimeng_local", name="即梦 · 隔离测试", base_url=catalog_origin, api_key="ui-test-only-not-real", model='["jimeng-2.0-fast"]', priority=10, created_at=ts, updated_at=ts)
                    insert(db, "ai_service_configs", service_type="image", provider="openai", name="测试图片配置", base_url=catalog_origin, api_key="ui-test-only-not-real", model='["test-image"]', created_at=ts, updated_at=ts)
                    drama = insert(db, "dramas", title="即梦接入 · 隔离界面验收", style="3d", aspect_ratio="16:9", status="draft", created_at=ts, updated_at=ts)
                    episode = insert(db, "episodes", drama_id=drama, episode_number=1, title="第一集", script_content="第一集：测试剧本，使用合成素材，仅验证界面。", video_config_id=cfg, image_config_id=2, created_at=ts, updated_at=ts)
                    character = insert(db, "characters", drama_id=drama, name="母亲", role="主角", image_url="static/asset.png", created_at=ts, updated_at=ts)
                    scene = insert(db, "scenes", drama_id=drama, episode_id=episode, location="周启卧室", time="夜晚", prompt="测试场景", image_url="static/asset.png", created_at=ts, updated_at=ts)
                    prop = insert(db, "props", drama_id=drama, name="药瓶", description="测试道具", image_url="static/asset.png", created_at=ts, updated_at=ts)
                    insert(db, "episode_characters", episode_id=episode, character_id=character, created_at=ts)
                    insert(db, "episode_scenes", episode_id=episode, scene_id=scene, created_at=ts)
                    insert(db, "episode_props", episode_id=episode, prop_id=prop, created_at=ts)
                    shot = insert(db, "storyboards", episode_id=episode, scene_id=scene, storyboard_number=1, title="测试镜头", description="母亲在卧室拿起药瓶。", video_prompt="🙂 @母亲站A(X+0.8米，Y0)，从桌边拿起@药瓶。场景：@周启卧室。", duration=12, video_url="static/old.mp4", created_at=ts, updated_at=ts)
                    insert(db, "storyboard_characters", storyboard_id=shot, character_id=character)
                    insert(db, "storyboard_props", storyboard_id=shot, prop_id=prop)
                    task = insert(db, "sys_task", type="video", storyboard_id=shot, drama_id=drama, provider="jimeng_local", model="jimeng-2.0-fast", status="failed", stage="failed", error_code="generation_failed", error_msg="参考图可能包含低俗内容，请修改后重试。", params='{}', created_at=ts, updated_at=ts)
                with sync_playwright() as playwright:
                    browser = playwright.chromium.launch(channel="msedge", headless=True)
                    context = browser.new_context(viewport={"width": 1440, "height": 1000}, locale="zh-CN")
                    context.add_init_script("localStorage.setItem('huobao:tours', JSON.stringify(['index','settings','detail','episode']))")
                    page = context.new_page()
                    page.on("pageerror", lambda error: errors.append(str(error)))
                    def route_handler(route):
                        url = route.request.url
                        if url.startswith(origin) or url.startswith("data:") or url.startswith("blob:"): route.continue_()
                        else: route.abort()
                    context.route("**/*", route_handler)
                    page.goto(origin + "/settings", wait_until="networkidle")
                    page.locator(".template-type-chip").filter(has_text="视频").click()
                    dialog = page.locator(".config-dialog")
                    dialog.get_by_role("button", name="即梦 · 本地服务", exact=True).click()
                    fields = dialog.locator("label.field")
                    fields.filter(has_text="API Key").locator("input").fill("ui-test-only-not-real")
                    fields.filter(has_text="Base URL").locator("input").fill(catalog_origin)
                    with page.expect_response(lambda response: response.url.endswith('/api/v1/ai-configs/models')) as model_response:
                        dialog.get_by_role("button", name="获取视频模型", exact=True).click()
                    assert model_response.value.json()["data"]["models"][0]["id"] == "jimeng-2.0-fast"
                    expect(dialog.get_by_text("这是本地已适配型号", exact=False)).to_be_visible()
                    dialog.locator(".test-draft-btn").click()
                    expect(dialog.locator(".test-result.ok")).to_be_visible()
                    page.screenshot(path=str(ARTIFACT / "settings-desktop.png"), full_page=True)
                    page.set_viewport_size({"width": 1000, "height": 780})
                    dialog.locator('.config-dialog-body').evaluate('(element) => { element.scrollTop = element.scrollHeight }')
                    expect(dialog.get_by_role('button', name='获取视频模型', exact=True)).to_be_visible()
                    assert dialog.bounding_box()['width'] <= 1000
                    page.screenshot(path=str(ARTIFACT / "settings-compact.png"), full_page=True)
                    dialog.get_by_role("button", name="取消", exact=True).click()
                    page.set_viewport_size({"width": 1920, "height": 1080})
                    page.goto(origin + f"/drama/{drama}/episode/1", wait_until="networkidle")
                    page.locator(".pipe-item").filter(has_text="视频制作").click()
                    expect(page.locator(".jimeng-settings")).to_be_visible()
                    expect(page.get_by_text("本次任务失败：", exact=False)).to_be_visible()
                    expect(page.locator(".video-task-row.is-failed")).to_have_count(1)
                    assert page.locator(".jimeng-settings select").nth(0).input_value() == "15"
                    assert page.locator(".video-player-video").count() == 1
                    page.screenshot(path=str(ARTIFACT / "video-failed-old-preview.png"), full_page=True)
                    # Mutate synthetic status only. The backend never submits these jobs.
                    with connect_database(database) as db:
                        db.execute("UPDATE sys_task SET status='processing',stage='generating',error_code=NULL,error_msg=NULL,updated_at=? WHERE id=?", ("2026-11-05T01:01:00.000Z", task))
                    page.get_by_role("button", name="刷新", exact=True).first.click()
                    expect(page.locator(".video-task-row.is-pending")).to_have_count(1)
                    expect(page.get_by_text("本次任务：", exact=False)).to_be_visible()
                    page.screenshot(path=str(ARTIFACT / "video-pending-old-preview.png"), full_page=True)
                    with connect_database(database) as db:
                        db.execute("UPDATE sys_task SET status='completed',stage='ready_in_local_service',params=?,updated_at=? WHERE id=?", (json.dumps({"manualDelivery": True}), "2026-11-05T01:02:00.000Z", task))
                    page.get_by_role("button", name="刷新", exact=True).first.click()
                    expect(page.get_by_text("已出片 · 本地下载", exact=True)).not_to_have_count(0)
                    expect(page.get_by_text("新视频已在即梦出片", exact=False)).to_be_visible()
                    page.screenshot(path=str(ARTIFACT / "video-manual-ready.png"), full_page=True)
                    # Explicitly select this shot for the existing batch-confirmation UI.
                    page.locator(".video-toolbar-actions").get_by_role("button", name="选择", exact=True).click() if page.locator(".video-toolbar-actions").count() else page.get_by_role("button", name="选择", exact=True).click()
                    page.locator(".video-task-row").first.click()
                    page.get_by_role("button", name="生成所选(1)", exact=True).click()
                    expect(page.locator(".batch-video-dialog")).to_be_visible()
                    expect(page.locator(".batch-video-dialog").get_by_text("15 秒 · 16:9", exact=True)).to_be_visible()
                    page.locator('.batch-video-dialog').evaluate('(element) => Promise.all(element.getAnimations({subtree:true}).filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished))')
                    page.screenshot(path=str(ARTIFACT / "batch-confirm.png"), full_page=True)
                    page.locator(".batch-video-dialog").get_by_role("button", name="取消", exact=True).click()
                    browser.close()
                assert not errors, errors
                assert CALLS and all(method == "GET" for method, _path in CALLS), CALLS
                (ARTIFACT / "result.json").write_text(json.dumps({"success": True, "screenshots": 6, "pageErrors": errors, "fakeServiceCalls": CALLS, "realGenerationRequests": 0, "isolatedPort": port}, ensure_ascii=False, indent=2), encoding="utf-8")
            finally:
                proc.terminate()
                try: proc.wait(timeout=10)
                except subprocess.TimeoutExpired: proc.kill(); proc.wait(timeout=10)
                catalog.shutdown(); catalog.server_close()
    print(str(ARTIFACT))


if __name__ == "__main__": main()
