"""
共享 fixtures / fixtures for e2e tests.

启动真实 aha-server,可选启动 TUI 客户端,提供 Playwright browser factory。
"""
import asyncio
import os
import subprocess
import time
from contextlib import asynccontextmanager

import pytest_asyncio
import pytest
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SERVER_DIR = os.path.join(ROOT, 'packages', 'server', 'src', 'index.js')
TUI_DIR = os.path.join(ROOT, 'packages', 'client-tui', 'src', 'index.js')
BROWSER_URL = 'http://localhost:PORT'  # placeholder


async def _wait_http(port, timeout=5.0):
    import urllib.request
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/health', timeout=0.5) as r:
                if r.status == 200:
                    return
        except Exception:
            await asyncio.sleep(0.1)
    raise TimeoutError(f'server on port {port} did not become healthy')


async def _start_server(port):
    proc = subprocess.Popen(
        ['node', SERVER_DIR],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        env={**os.environ, 'PORT': str(port), 'HOST': '127.0.0.1'},
    )
    try:
        await _wait_http(port)
    except Exception:
        out, _ = proc.communicate(timeout=1)
        print(f'[e2e] server failed to start: {out.decode(errors="ignore")}')
        proc.kill()
        raise
    return proc


@pytest_asyncio.fixture(scope='session')
async def server_port():
    """找一个空闲端口,启动 aha-server,返回端口号。session 级。"""
    import socket
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        port = s.getsockname()[1]
    print(f'\n[e2e] starting server on port {port}')
    proc = await _start_server(port)
    print(f'[e2e] server healthy on port {port}')
    yield port
    proc.terminate()
    try:
        proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        proc.kill()


@pytest_asyncio.fixture(scope='session')
async def server_url(server_port):
    return f'http://localhost:{server_port}'


@pytest_asyncio.fixture
async def tui_client(server_port):
    """启动一个 TUI 客户端(auto-answer),用完即关闭。"""
    log_path = '/tmp/tui_e2e.log'
    log_f = open(log_path, 'wb')
    proc = subprocess.Popen(
        ['node', TUI_DIR, '--auto-answer', '--name', 'TUI-E2E', '--server', f'ws://127.0.0.1:{server_port}'],
        stdout=log_f, stderr=subprocess.STDOUT,
        env={**os.environ, 'TERM': 'dumb', 'AHA_DEBUG': '0'},
    )
    # 等 TUI 注册 (服务端 /api/peers)
    import urllib.request, json
    deadline = time.time() + 10
    registered = False
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{server_port}/api/peers', timeout=0.5) as r:
                peers = json.loads(r.read())['peers']
                if any(p['name'] == 'TUI-E2E' for p in peers):
                    registered = True
                    break
        except Exception:
            pass
        await asyncio.sleep(0.2)
    if not registered:
        log_f.flush()
        with open(log_path) as f:
            print('[e2e] TUI log:', f.read()[-500:])
    assert registered, 'TUI failed to register within 10s'
    yield {'proc': proc, 'log_path': log_path}
    proc.terminate()
    try:
        proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        proc.kill()
    log_f.close()


@pytest_asyncio.fixture
async def browser_pair():
    """启动两个独立的 browser contexts (allow multiple clients on same origin)."""
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=[
                '--no-sandbox',
                '--use-fake-ui-for-media-stream',
                '--use-fake-device-for-media-stream',
            ],
        )
        ctx1 = await browser.new_context()
        ctx2 = await browser.new_context()
        page1 = await ctx1.new_page()
        page2 = await ctx2.new_page()
        try:
            yield browser, page1, page2
        finally:
            await browser.close()


@pytest_asyncio.fixture
async def two_browsers(browser_pair):
    _, page1, page2 = browser_pair
    yield page1, page2