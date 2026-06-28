"""
E2E test: 两个浏览器客户端互通 + 与 TUI 客户端中继互通
"""
import asyncio
import sys
import os
import subprocess
import time
import json

# Add /home/wz/source/aha to sys.path so we can import local modules
sys.path.insert(0, '/home/wz/source/aha/packages/server/src')

from playwright.async_api import async_playwright

SERVER = "http://localhost:3000"

async def fake_media(page):
    """注入 fake microphone/camera,避免实际设备"""
    await page.add_init_script("""
        window.__fakeStream = null;
        async function getFakeStream(withVideo) {
            if (window.__fakeStream && window.__fakeStream.withVideo === withVideo) return window.__fakeStream.stream;
            // 用 canvas + audio context 合成
            const ac = new AudioContext();
            const osc = ac.createOscillator();
            const dest = ac.createMediaStreamDestination();
            osc.frequency.value = 440;
            osc.connect(dest);
            osc.start();

            let stream = new MediaStream();
            stream.addTrack(dest.stream.getAudioTracks()[0]);
            window.__fakeStream = { stream, withVideo };

            if (withVideo) {
                const canvas = document.createElement('canvas');
                canvas.width = 320; canvas.height = 240;
                const ctx = canvas.getContext('2d');
                let t0 = Date.now();
                function loop() {
                    const t = (Date.now() - t0) / 1000;
                    ctx.fillStyle = `hsl(${(t * 60) % 360}, 60%, 50%)`;
                    ctx.fillRect(0, 0, 320, 240);
                    ctx.fillStyle = 'white';
                    ctx.font = '24px sans-serif';
                    ctx.fillText('AHA', 130, 130);
                    requestAnimationFrame(loop);
                }
                loop();
                stream.addTrack(canvas.captureStream(15).getVideoTracks()[0]);
            }
            return stream;
        }

        const origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async (constraints) => {
            const wantVideo = !!(constraints && constraints.video);
            try {
                return await getFakeStream(wantVideo);
            } catch (e) {
                console.error('fake media failed', e);
                return await origGetUserMedia(constraints);
            }
        };
    """)


async def wait_for_peer(page, target_count, timeout=8000):
    t0 = time.time()
    while time.time() - t0 < timeout / 1000:
        count = await page.evaluate("document.getElementById('peer-count')?.textContent || '0'")
        if int(count) >= target_count:
            return True
        await asyncio.sleep(0.2)
    return False


async def main():
    print('[e2e] starting')
    tui_proc = None

    # 启动 TUI 客户端(自动应答模式)
    print('[e2e] starting TUI client (auto-answer)')
    tui_log = open('/tmp/tui_e2e.log', 'wb')
    tui_proc = subprocess.Popen(
        ['node', '/home/wz/source/aha/packages/client-tui/src/index.js',
         '--auto-answer', '--name', 'TUI-Auto'],
        stdout=tui_log, stderr=subprocess.STDOUT,
        env={**os.environ, 'TERM': 'dumb', 'AHA_DEBUG': '1'},
    )
    print(f'[e2e] TUI pid={tui_proc.pid}')
    time.sleep(3)
    print(f'[e2e] TUI alive: {tui_proc.poll() is None}')
    # 给 TUI 一段时间注册
    await asyncio.sleep(1.5)

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
        )

        # 两个浏览器 context(允许同一 origin 多客户端)
        ctx1 = await browser.new_context()
        ctx2 = await browser.new_context()

        page1 = await ctx1.new_page()
        page2 = await ctx2.new_page()
        await fake_media(page1)
        await fake_media(page2)

        for i, page in enumerate([page1, page2]):
            page.on('console', lambda msg, n=i: print(f'  [browser-{n+1}/{msg.type}] {msg.text}') if (msg.type == 'error' or '[aha]' in msg.text) else None)
            page.on('pageerror', lambda err, n=i: print(f'  [browser-{n+1}/error] {err}'))

        # 拦截信令消息,在 page 上记录
        for i, page in enumerate([page1, page2]):
            await page.add_init_script(f"""
                window.__msgLog = [];
                const origWS = WebSocket;
                window.WebSocket = class extends origWS {{
                    constructor(...args) {{
                        super(...args);
                        this.addEventListener('message', (e) => {{
                            try {{
                                const m = JSON.parse(e.data);
                                window.__msgLog.push(m.type + ':' + (m.payload?.callId || m.payload?.status || ''));
                            }} catch (_) {{}}
                        }});
                    }}
                }};
            """)

        print('[e2e] opening pages')
        await page1.goto(SERVER + '/')
        await page2.goto(SERVER + '/')

        # 设置名字
        for i, page in enumerate([page1, page2]):
            await page.fill('#display-name', f'Browser-{i+1}')

        # 点击连接
        print('[e2e] clicking connect on both')
        await page1.click('#connect-btn')
        await page2.click('#connect-btn')
        await asyncio.sleep(1.0)

        # 等候 TUI 出现在列表
        print('[e2e] waiting for TUI in peer list')
        saw_tui_1 = False
        saw_tui_2 = False
        for attempt in range(30):
            list1 = await page1.eval_on_selector_all('#peer-list li', "els => els.map(e => e.textContent.trim())")
            list2 = await page2.eval_on_selector_all('#peer-list li', "els => els.map(e => e.textContent.trim())")
            saw_tui_1 = any('TUI-Auto' in t for t in list1)
            saw_tui_2 = any('TUI-Auto' in t for t in list2)
            if saw_tui_1 and saw_tui_2 and len(list1) >= 2 and len(list2) >= 2:
                break
            await asyncio.sleep(0.3)
        print(f'[e2e] page1 sees: {list1}')
        print(f'[e2e] page2 sees: {list2}')
        print(f'[e2e] page1 list1 len={len(list1)}')

        # 调试:列出当前服务端 peers
        try:
            import urllib.request
            with urllib.request.urlopen(SERVER + '/api/peers', timeout=1) as resp:
                peer_data = json.loads(resp.read())
            print(f'[e2e] server peers: {[p["name"] for p in peer_data["peers"]]}')
        except Exception as e:
            print(f'[e2e] failed to fetch /api/peers: {e}')

        assert saw_tui_1, 'page1 should see TUI'
        assert saw_tui_2, 'page2 should see TUI'

        # 浏览器1 呼叫浏览器2
        print('[e2e] selecting page2 on page1')
        # 从 call-target select 选取第一个非 TUI 的 option
        page2_id = await page2.evaluate("document.getElementById('self-id')?.textContent")
        print(f'[e2e] page2 short id: {page2_id}')
        # 找到对应的全 ID 通过 peer-list
        target_full_id = await page1.evaluate(f"""
            (() => {{
                const items = document.querySelectorAll('#peer-list li');
                for (const li of items) {{
                    if (li.textContent.includes('Browser-2')) {{
                        return li.dataset.clientId;
                    }}
                }}
                return null;
            }})()
        """)
        print(f'[e2e] page2 full id on page1: {target_full_id}')
        await page1.select_option('#call-target', value=target_full_id)
        await page1.click('#call-audio-btn')
        await asyncio.sleep(1.5)

        # 检查 page2 收到来电
        print('[e2e] checking incoming on page2')
        incoming_visible = await page2.is_visible('#incoming-panel')
        print(f'[e2e] incoming visible: {incoming_visible}')
        assert incoming_visible, 'page2 should see incoming call'

        # 接听
        await page2.click('#answer-btn')
        await asyncio.sleep(2.0)

        # 检查两端状态
        s1 = await page1.text_content('#status-text')
        s2 = await page2.text_content('#status-text')
        print(f'[e2e] status page1={s1!r} page2={s2!r}')

        # 等候 ICE 连接完成
        await asyncio.sleep(3.0)
        s1 = await page1.text_content('#status-text')
        s2 = await page2.text_content('#status-text')
        print(f'[e2e] after wait: status page1={s1!r} page2={s2!r}')

        # 验证 RTCPeerConnection 连接状态
        conn_state_1 = await page1.evaluate("""
            (() => {
                if (!window._ahaApp) return 'no-app';
                const app = window._ahaApp;
                if (!app.peer) return 'no-peer';
                return app.peer.pc.iceConnectionState + '/' + app.peer.pc.connectionState;
            })()
        """)
        conn_state_2 = await page2.evaluate("""
            (() => {
                if (!window._ahaApp) return 'no-app';
                const app = window._ahaApp;
                if (!app.peer) return 'no-peer';
                return app.peer.pc.iceConnectionState + '/' + app.peer.pc.connectionState;
            })()
        """)
        print(f'[e2e] ICE states: page1={conn_state_1} page2={conn_state_2}')
        assert 'connected' in conn_state_1 or 'completed' in conn_state_1, f'page1 ICE not connected: {conn_state_1}'
        assert 'connected' in conn_state_2 or 'completed' in conn_state_2, f'page2 ICE not connected: {conn_state_2}'

        # 静音控制
        print('[e2e] testing mute control')
        await page1.click('#mute-btn')
        await asyncio.sleep(0.5)
        mute_text = await page1.text_content('#mute-btn')
        print(f'[e2e] mute button: {mute_text!r}')

        # 挂断
        print('[e2e] hangup')
        await page1.click('#hangup-btn')
        await asyncio.sleep(1.0)
        s1 = await page1.text_content('#status-text')
        s2 = await page2.text_content('#status-text')
        print(f'[e2e] after hangup: page1={s1!r} page2={s2!r}')

        # 验证通话记录
        print('[e2e] checking call records')
        await page1.click('#refresh-records')
        await asyncio.sleep(0.5)
        records = await page1.eval_on_selector_all('#records-list li', "els => els.map(e => e.textContent.trim())")
        print(f'[e2e] records: {records}')
        assert len(records) >= 1, 'should have at least one call record'

        # TUI ↔ 浏览器中继测试
        print('[e2e] test TUI <-> Browser relay')
        # 在浏览器端呼叫 TUI
        tui_full_id = await page1.evaluate("""
            (() => {
                const items = document.querySelectorAll('#peer-list li');
                for (const li of items) {
                    if (li.textContent.includes('TUI-Auto')) {
                        return li.dataset.clientId;
                    }
                }
                return null;
            })()
        """)
        print(f'[e2e] TUI full id on page1: {tui_full_id}')
        if tui_full_id:
            await page1.select_option('#call-target', value=tui_full_id)
            await page1.click('#call-audio-btn')
            await asyncio.sleep(2.0)
            # TUI 自动应答中...通话会通过中继模式
            # 等待几秒
            await asyncio.sleep(3.0)
            s1 = await page1.text_content('#status-text')
            print(f'[e2e] after TUI call, page1 status: {s1!r}')
            # 挂断
            try:
                await page1.click('#hangup-btn', timeout=2000)
            except Exception:
                pass
            await asyncio.sleep(1.0)

        await page1.screenshot(path='/tmp/page1.png', full_page=True)
        await page2.screenshot(path='/tmp/page2.png', full_page=True)
        print('[e2e] screenshots saved to /tmp/page1.png /tmp/page2.png')

        await browser.close()

    if tui_proc:
        tui_proc.terminate()
        try:
            tui_proc.wait(timeout=3)
        except Exception:
            tui_proc.kill()
            tui_proc.wait(timeout=2)

    # 读取 TUI 日志
    try:
        with open('/tmp/tui_e2e.log', 'rb') as f:
            data = f.read()
        # 提取字符串
        text = data.decode(errors='ignore')
        print('[e2e] TUI log tail:')
        print(text[-1500:])
    except Exception as e:
        print('[e2e] failed to read TUI log:', e)

    print('[e2e] all done')


if __name__ == '__main__':
    asyncio.run(main())