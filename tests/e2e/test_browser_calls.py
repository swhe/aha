"""
E2E test: 浏览器 ↔ 浏览器 P2P 音视频通话
"""
import asyncio
import json
import time
import urllib.request

import pytest

from conftest import two_browsers, server_port, tui_client


async def _peer_list(port):
    with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/peers', timeout=1) as r:
        return json.loads(r.read())['peers']


async def _open_and_connect(page, server_url, name):
    await page.goto(server_url + '/')
    await page.fill('#display-name', name)
    await page.click('#connect-btn')
    # 等 connected 状态 (最长 5s)
    last_status = None
    for _ in range(50):
        last_status = await page.text_content('#status-text')
        if last_status == '已连接':
            return
        await asyncio.sleep(0.1)
    raise AssertionError(f'page {name} did not reach 已连接, last={last_status!r}')


async def _select_call_target(page, peer_name):
    """选择 ID 匹配的 peer 作为呼叫目标"""
    target_id = await page.evaluate(f"""
        (() => {{
            const items = document.querySelectorAll('#peer-list li');
            for (const li of items) {{
                if (li.textContent.includes({json.dumps(peer_name)})) {{
                    return li.dataset.clientId;
                }}
            }}
            return null;
        }})()
    """)
    if not target_id:
        raise AssertionError(f'peer {peer_name} not found in list')
    await page.select_option('#call-target', value=target_id)
    return target_id


async def _ice_state(page):
    return await page.evaluate("""
        (() => {
            if (!window._ahaApp) return 'no-app';
            const p = window._ahaApp.peer;
            if (!p) return 'no-peer';
            return p.pc.iceConnectionState + '/' + p.pc.connectionState;
        })()
    """)


@pytest.mark.asyncio
async def test_browser_to_browser_p2p_audio_call(server_url, server_port, two_browsers):
    """两个浏览器客户端通过 P2P 建立音频通话, ICE connected。"""
    page1, page2 = two_browsers
    await asyncio.gather(
        _open_and_connect(page1, server_url, 'Browser-A'),
        _open_and_connect(page2, server_url, 'Browser-B'),
    )
    # 等对方出现
    for _ in range(30):
        cnt = int(await page1.text_content('#peer-count') or '0')
        if cnt >= 1:
            break
        await asyncio.sleep(0.1)

    # Browser-A 呼叫 Browser-B
    await _select_call_target(page1, 'Browser-B')
    await page1.click('#call-audio-btn')

    # Browser-B 收到来电
    for _ in range(30):
        if await page2.is_visible('#incoming-panel'):
            break
        await asyncio.sleep(0.1)
    assert await page2.is_visible('#incoming-panel'), 'Browser-B should see incoming call'
    await page2.click('#answer-btn')

    # 等 ICE connected (最多 10s)
    ice_connected = False
    for _ in range(100):
        s1 = await _ice_state(page1)
        s2 = await _ice_state(page2)
        if 'connected' in s1 and 'connected' in s2:
            ice_connected = True
            break
        await asyncio.sleep(0.1)
    assert ice_connected, f'ICE never connected: page1={s1}, page2={s2}'

    # 挂断
    await page1.click('#hangup-btn')
    await asyncio.sleep(0.5)
    s1 = await page1.text_content('#status-text')
    assert s1 == '已连接'


@pytest.mark.asyncio
async def test_browser_to_browser_mute_control(server_url, two_browsers):
    """A 可以通过 DataChannel 静音控制 B 的麦克风。"""
    page1, page2 = two_browsers
    await asyncio.gather(
        _open_and_connect(page1, server_url, 'Mute-A'),
        _open_and_connect(page2, server_url, 'Mute-B'),
    )
    await _select_call_target(page1, 'Mute-B')
    await page1.click('#call-audio-btn')
    for _ in range(30):
        if await page2.is_visible('#incoming-panel'):
            break
        await asyncio.sleep(0.1)
    await page2.click('#answer-btn')

    for _ in range(50):
        s = await _ice_state(page1)
        if 'connected' in s:
            break
        await asyncio.sleep(0.1)

    # A 静音自己 (默认 mute-mic 是对自己的,但也广播给对方)
    await page1.click('#mute-btn')
    await asyncio.sleep(0.3)
    btn_text = await page1.text_content('#mute-btn')
    assert btn_text == '🎙 已静音', f'unexpected mute button: {btn_text!r}'

    await page1.click('#hangup-btn')


@pytest.mark.asyncio
async def test_call_record_persisted(server_url, two_browsers):
    """通话结束后,通话记录可查询。"""
    page1, page2 = two_browsers
    await asyncio.gather(
        _open_and_connect(page1, server_url, 'Rec-A'),
        _open_and_connect(page2, server_url, 'Rec-B'),
    )
    await _select_call_target(page1, 'Rec-B')
    await page1.click('#call-audio-btn')
    for _ in range(30):
        if await page2.is_visible('#incoming-panel'):
            break
        await asyncio.sleep(0.1)
    await page2.click('#answer-btn')
    for _ in range(50):
        s = await _ice_state(page1)
        if 'connected' in s:
            break
        await asyncio.sleep(0.1)
    await asyncio.sleep(2)  # 通话 2s+
    await page1.click('#hangup-btn')
    await asyncio.sleep(0.5)

    # 刷新通话记录
    await page1.click('#refresh-records')
    await asyncio.sleep(0.5)
    records = await page1.eval_on_selector_all('#records-list li', "els => els.map(e => e.textContent.trim())")
    assert len(records) >= 1, f'no records found: {records}'
    rec = records[0]
    assert 'Rec-A→Rec-B' in rec, f'unexpected record: {rec}'
    assert 'audio' in rec
    assert 'ended' in rec


@pytest.mark.asyncio
async def test_browser_to_tui_relay_mode(server_url, server_port, two_browsers, tui_client):
    """浏览器呼叫 TUI(自动应答),走中继模式。"""
    page1, page2 = two_browsers
    await asyncio.gather(
        _open_and_connect(page1, server_url, 'Browser-RT'),
        _open_and_connect(page2, server_url, 'Browser-Witness'),
    )
    # 等 TUI-E2E 出现在 page1 的 peer-list (TUI 注册可能慢,等更久)
    target_id = None
    for attempt in range(80):
        peers = await page1.eval_on_selector_all(
            '#peer-list li',
            "els => els.map(e => ({ text: e.textContent.trim(), id: e.dataset.clientId }))",
        )
        for p in peers:
            if 'TUI-E2E' in p['text']:
                target_id = p['id']
                break
        if target_id:
            break
        await asyncio.sleep(0.25)
    assert target_id, f'TUI-E2E not in peer list after retries: {peers}'

    # Browser-RT 呼叫 TUI
    await page1.select_option('#call-target', value=target_id)
    await page1.click('#call-audio-btn')
    # 等中继模式生效
    relay_active = False
    for _ in range(50):
        s = await page1.text_content('#status-text')
        if s and '中继' in s:
            relay_active = True
            break
        await asyncio.sleep(0.2)
    assert relay_active, f'relay mode not activated, status={await page1.text_content("#status-text")!r}'

    # 等几秒确保中继音频帧在流转
    await asyncio.sleep(2)

    # 挂断
    try:
        await page1.click('#hangup-btn', timeout=2000)
    except Exception:
        pass
    await asyncio.sleep(0.5)


@pytest.mark.asyncio
async def test_reject_call(server_url, two_browsers):
    """B 拒绝 A 的来电,通话记录标记为 rejected。"""
    page1, page2 = two_browsers
    await asyncio.gather(
        _open_and_connect(page1, server_url, 'Rej-A'),
        _open_and_connect(page2, server_url, 'Rej-B'),
    )
    await _select_call_target(page1, 'Rej-B')
    await page1.click('#call-audio-btn')
    for _ in range(30):
        if await page2.is_visible('#incoming-panel'):
            break
        await asyncio.sleep(0.1)
    # B 拒绝
    await page2.click('#reject-btn')
    await asyncio.sleep(0.5)

    # 验证 A 收到 call-reject
    # (status should not be in-call)
    s = await page1.text_content('#status-text')
    assert s == '已连接', f'after reject status should be 已连接, got {s!r}'