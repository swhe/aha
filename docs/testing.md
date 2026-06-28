# 测试指南

## 概览

三层测试架构,共同覆盖服务器逻辑、客户端模块、端到端真实场景。

| 层级 | 工具 | 范围 | 运行时间 | 数量 |
|------|------|------|----------|------|
| 单元测试 | `node:test` (内置) | 纯函数/类(无 I/O) | ~1s | 33 |
| 组件/集成测试 | `node:test` + `ws` | 真实启动 server,模拟 WS 客户端 | ~3s | 18 |
| 端到端测试 | Playwright + pytest | 真实 Chromium + TUI 子进程 | ~14s | 5 |

## 目录

```
tests/
├── unit/                         # 无 I/O,纯逻辑
│   ├── server/
│   │   ├── registry.test.js      # 客户端注册/心跳/超时清理
│   │   ├── call-records.test.js  # 通话记录 CRUD/duration 计算
│   │   ├── relay.test.js         # 中继 session/转发/启停
│   │   └── types.test.js         # MSG/CALL_STATUS 常量完整性
│   └── tui/
│       ├── id.test.js            # clientId 生成 (MAC+随机)
│       └── media.test.js         # opusscript 编解码 + ffmpeg 子进程
│
├── integration/                  # 启动真实 server + ws 客户端
│   ├── helpers.js                # startServer / WsClient / waitFor 工具
│   ├── signaling-basic.test.js   # 注册/peer-list/heartbeat/错误
│   ├── signaling-call.test.js    # 完整通话流(呼叫/接听/挂断/拒绝/ICE/控制/记录)
│   ├── relay.test.js             # 音频转发 + session 隔离
│   └── signaling-edge.test.js    # 自动应答 / 掉线清理 / 重连
│
└── e2e/                          # 真实浏览器 + TUI 子进程
    ├── conftest.py               # server_port / browser_pair / tui_client fixtures
    └── test_browser_calls.py     # 浏览器 P2P / 静音 / 记录 / 中继 / 拒绝
```

## 运行

### 全部测试

```bash
npm run test:all
```

### 分层

```bash
npm run test:unit           # 单元 (~1s)
npm run test:integration    # 集成 (~3s,需 ffmpeg + ports)
npm run test:e2e            # 端到端 (~14s,需 ffmpeg + Playwright)
```

### 直接用 node / pytest

```bash
node --test tests/unit/**/*.test.js
node --test tests/integration/**/*.test.js
python3 -m pytest tests/e2e/
```

## 编写新测试

### 单元测试

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const MyModule = require('../../../packages/server/src/my-module');

test('MyModule: foo does bar', () => {
  const m = new MyModule();
  assert.equal(m.foo(), 'bar');
});
```

### 集成测试

```js
const { startServer, stopServer, WsClient } = require('./helpers');

let server;
test.before(async () => { server = await startServer(); });
test.after(async () => { await stopServer(server); });

test('feature: scenario', async () => {
  const a = new WsClient(server.port, 'client-a', { name: 'A' });
  const b = new WsClient(server.port, 'client-b', { name: 'B' });
  await a.connect();
  await b.connect();

  a.send('call-offer', { callId: 'c1', calleeId: 'client-b', callType: 'audio', sdp: 'x', callerName: 'A' });
  const incoming = await b.waitFor('call-incoming', 2000);
  assert.equal(incoming.payload.callId, 'c1');

  a.close(); b.close();
});
```

### E2E 测试

```python
import pytest

@pytest.mark.asyncio
async def test_my_feature(server_url, two_browsers):
    page1, page2 = two_browsers
    await _open_and_connect(page1, server_url, 'Test-A')
    await _open_and_connect(page2, server_url, 'Test-B')
    # ...
```

## Fixtures(E2E)

| Fixture | Scope | 用途 |
|---------|-------|------|
| `server_port` | session | 随机端口启动 server,返回端口号 |
| `server_url` | session | server 的 URL(`http://localhost:PORT`) |
| `browser_pair` | function | 两个独立 Chromium context,允许同源多客户端 |
| `two_browsers` | function | 简化为 `(page1, page2)` |
| `tui_client` | function | 启动 TUI 客户端(auto-answer),等注册完成 |

## 故障排查

| 问题 | 解决 |
|------|------|
| `Cannot find module 'ws'` | `npm install` |
| `playwright` 模块缺失 | `/home/wz/source/py3env/bin/pip install playwright pytest-asyncio` |
| `chromium` 浏览器缺失 | `/home/wz/source/py3env/bin/playwright install chromium` |
| E2E 超时 | 确认 server 已停止(残留进程占用端口) |
| TUI 测试失败 | 确认 ffmpeg 已安装且 ALSA 设备可用 |

## CI 集成

`npm test` 跑单元 + 集成;`npm run test:e2e` 跑 E2E(需 GUI 依赖)。

```yaml
# .github/workflows/test.yml (示例)
- run: npm ci
- run: npm run test:unit
- run: npm run test:integration
# E2E 需要 GUI 依赖,通常 nightly 跑
- run: |
    pip install playwright pytest-asyncio
    playwright install chromium
    npm run test:e2e
```