# AHA - 音视频在线对话系统

一个 P2P 优先、P2P 失败自动回落到服务端中继的音视频对话系统。
包含一个 WebSocket 信令服务端,以及两种客户端:浏览器(完整音视频)和终端 TUI(仅音频)。

## 目录结构

```
aha/
├── packages/
│   ├── server/                  # 信令 + 中继服务端
│   │   └── src/
│   │       ├── index.js         # HTTP + WebSocket 入口
│   │       ├── signaling.js     # 信令路由 + 通话状态机
│   │       ├── registry.js      # 客户端注册 / 心跳 / 在线列表
│   │       ├── relay.js         # P2P fallback 中继
│   │       ├── call-records.js  # 通话记录(内存)
│   │       └── types.js         # 消息类型常量
│   │
│   ├── client-browser/          # 浏览器客户端(打开 / 即可使用)
│   │   └── public/
│   │       ├── index.html
│   │       ├── styles.css
│   │       └── src/
│   │           ├── app.js       # 主逻辑
│   │           ├── signaling.js # WS 客户端
│   │           ├── peer.js      # RTCPeerConnection 封装
│   │           ├── media.js     # getUserMedia / 静音 / 开关摄像头
│   │           ├── id.js        # 客户端ID生成
│   │           └── utils.js     # 消息类型 / 工具
│   │
│   └── client-tui/              # 终端 TUI 客户端
│       └── src/
│           ├── index.js         # CLI 入口
│           ├── tui.js           # blessed TUI 布局
│           ├── signaling.js     # WS 客户端
│           ├── media.js         # ffmpeg 录音/播放 + opusscript 编解码
│           ├── protocol.js      # 消息类型常量
│           └── id.js            # 客户端ID生成
│
├── package.json                 # npm workspaces 根
├── docs/architecture.md         # 详细架构设计
└── test-e2e.py                  # 端到端自动化测试
```

## 核心特性

| 特性 | 说明 |
|------|------|
| 服务端发现 | 客户端主动注册 + 心跳(15s),60s 无心跳清理 |
| P2P 协商 | WebRTC SDP/ICE(STUN: stun.l.google.com:19302) |
| P2P fallback | ICE 失败时切换到服务端中继(Opus-over-WS) |
| 通话记录 | 仅内存,默认名称 `<callerShortId>-<timestamp>` |
| 自动应答 | `--auto-answer` 启动,仅接听音频(终端 / 浏览器通用) |
| 远控指令 | 走 WebRTC DataChannel:mute-mic / cam-on / type-switch / global-mute |
| 唯一ID | MAC地址 SHA-256 前 8 字节 + 4 字节随机 |
| 中继数据格式 | 浏览器/TUI 之间通过 WS 转发 base64(opus) |

## 启动

### 1. 安装依赖

```bash
cd /home/wz/source/aha
npm install
```

### 2. 启动信令服务端(默认 3000 端口)

```bash
PORT=3000 npm run start:server
# 或直接: node packages/server/src/index.js
```

服务端同时托管浏览器客户端静态文件(访问 `http://localhost:3000/` 即为浏览器客户端)。

### 3. 启动浏览器客户端

打开 `http://localhost:3000/`,填写显示名,勾选"自动应答"可选,点击"连接"。

### 4. 启动终端 TUI 客户端

需要安装 ffmpeg + ALSA:

```bash
sudo apt install ffmpeg alsa-utils
# 启动(自动应答)
npm run start:tui-auto
# 或:node packages/client-tui/src/index.js --auto-answer

# 自定义名称
node packages/client-tui/src/index.js --name "TUI-Alice"
# 指定音频设备
node packages/client-tui/src/index.js --capture hw:0,0 --playback hw:0,0
```

TUI 客户端按键:

| 键 | 功能 |
|----|------|
| `↑/↓` | 在在线列表中选择 |
| `Enter` | 确认选择 |
| `C` | 发起语音呼叫(终端强制为语音) |
| `V` | 发起视频呼叫(终端降级为语音) |
| `A` | 接听来电 |
| `R` | 拒绝来电 / 挂断当前通话 |
| `H` | 挂断当前通话 |
| `M` | 切换本地静音 |
| `L` | 查看通话记录 |
| `U` | 切换自动应答(重新连接后生效) |
| `Q` | 退出 |

## 信令协议

所有消息均为 JSON,格式:

```json
{ "type": "<message-type>", "payload": { ... } }
```

| 消息 | 方向 | 说明 |
|------|------|------|
| `register` | C→S | 客户端注册,带 `clientId/deviceType/name/autoAnswer` |
| `register-ack` | S→C | 返回 `self` 信息 + 当前在线 `peers` |
| `heartbeat` | C→S | 心跳(15s) |
| `peer-list` | S→C | 在线列表变更广播 |
| `call-offer` | C→S | 发起通话(SDP) |
| `call-incoming` | S→C | 转发给被叫 |
| `call-answer` | C→S | 接听(SDP) |
| `call-answered` | S→C | 转发给主叫 |
| `call-ice` | C→S→C | ICE 候选透传 |
| `call-reject` | C→S | 拒绝 |
| `call-hangup` | C→S | 挂断 |
| `call-status` | C→S | 状态变更(connected/ended) |
| `call-status-update` | S→C | 状态广播 |
| `call-records-request` | C→S | 查询通话记录 |
| `call-records` | S→C | 通话记录列表 |
| `relay-start` | C→S | 请求中继(中继模式) |
| `relay-start-ack` | S→C | 中继建立 |
| `relay-audio` | C→S→C | Opus 帧透传(base64) |
| `control` | C→S→C | 远控指令(走 DataChannel 透传) |

## 通话记录模型

```js
{
  callId: 'c-xxxxx',
  callerId: '...',
  calleeId: '...',
  callerName: '...',
  calleeName: '...',
  callType: 'audio' | 'video',
  status: 'ringing' | 'connected' | 'ended' | 'rejected' | 'missed',
  startTime: '2026-...',
  endTime: '2026-...',
  duration: 5,  // 秒
  name: 'd8d9e1cd-mqxowev3',  // 默认: 短ID-时间戳(base36)
  relayMode: false
}
```

## NAT 穿透

- 默认使用 `stun:stun.l.google.com:19302`
- LAN 内通常直接连通
- 对称 NAT 下 P2P 失败,自动降级到服务端中继

## 远控指令(走 DataChannel)

```json
{ "action": "mute-mic" | "unmute-mic" | "cam-on" | "cam-off" | "type-switch" | "global-mute", "params": {} }
```

`type-switch` 携带 `{ newType: "audio" | "video" }`,需要重新协商 SDP。
终端客户端在收到 `cam-on/cam-off/type-switch` 时直接忽略(终端无视频)。

## 端到端测试

```bash
# 启动服务端
PORT=3000 node packages/server/src/index.js &

# 在另一终端运行 Playwright 测试
python3 test-e2e.py
```

测试覆盖:

1. 服务端注册 + 在线列表
2. Browser↔Browser P2P 通话(ICE connected)
3. 静音控制(mute button + DataChannel)
4. 挂断 + 通话记录
5. Browser↔TUI 中继模式(自动应答 + 音频帧转发)

## 已知限制

- 终端 TUI 不支持视频(只接听/发起音频)
- 终端 TUI 通话默认走中继模式(终端无法做 WebRTC SDP/ICE)
- 通话记录仅在内存,服务重启丢失
- 浏览器无 STUN 失败自动 TURN 降级(中继 fallback 是 fallback)
- 自动应答模式仅接听音频,拒绝视频
