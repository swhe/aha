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
| P2P fallback | ICE 失败时切换到服务端中继(PCM s16le over WS) |
| 通话记录 | 仅内存,默认名称 `<callerShortId>-<timestamp>` |
| 自动应答 | `--auto-answer` 启动,仅接听音频(终端 / 浏览器通用) |
| 远控指令 | 走 WebRTC DataChannel:mute-mic / cam-on / type-switch / global-mute |
| 唯一ID | 浏览器特征指纹(SHA-256 或 FNV-1a 回退) 前 8 字节 + 4 字节随机 |
| 中继数据格式 | TUI↔Browser 中继:PCM s16le 48k mono 20ms 帧,base64 over WS |
| 非安全上下文兼容 | ID 生成 + getUserMedia 在 http:// 非 loopback 时降级或给出明确提示 |

## 启动

### 1. 安装依赖

```bash
cd /home/wz/source/aha
npm install
```

### 2. 启动信令服务端

#### 2.1 普通 http(本机 / 127.0.0.1 访问,适合开发)

```bash
PORT=3000 npm run start:server
# 或: node packages/server/src/index.js
```

服务端同时托管浏览器客户端静态文件,本机访问 `http://localhost:3000/` 即可。

#### 2.2 HTTPS(LAN 访问,启用麦克风/摄像头必需)

`navigator.mediaDevices.getUserMedia` 只在 **secure context**(https 或 `localhost`/`127.0.0.1`)下可用。
如果想让手机、平板或局域网内其他电脑访问,必须开 HTTPS。

先生成一份自签证书(SAN 必须包含本机 LAN IP,否则浏览器会拒):

```bash
# 把 192.168.1.34 换成你机器的实际 IP( hostname -I 查看)
mkdir -p /tmp/aha-tls && cd /tmp/aha-tls
openssl req -x509 -newkey rsa:2048 -days 365 -nodes \
  -subj "/CN=aha-dev" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:192.168.1.34" \
  -keyout key.pem -out cert.pem
```

启动 server:

```bash
cd /home/wz/source/aha
PORT=3000 \
TLS_KEY=/tmp/aha-tls/key.pem \
TLS_CERT=/tmp/aha-tls/cert.pem \
node packages/server/src/index.js
```

输出:

```
[aha-server] listening on https://0.0.0.0:3443
[aha-server] WebSocket endpoint: wss://0.0.0.0:3443
```

HTTPS 端口默认是 `PORT + 443`(3000 → 3443)。可设 `HTTPS_PORT=443` 改回标准端口。

**首次浏览器访问**会显示"您的连接不是私密连接"(自签证书):
- Chrome / Edge:地址栏左侧"高级" → "继续前往 192.168.1.34(不安全)"
- Safari:"显示详细信息" → "访问此网站"
- Firefox:"高级" → "接受风险并继续"

只在第一次需要,之后浏览器记住。

> 生产环境请用正规 CA 签发的证书(Let's Encrypt 等),把 `TLS_KEY`/`TLS_CERT` 指过去即可。

### 3. 启动浏览器客户端

浏览器开 `http://localhost:3000/`(本机)或 `https://192.168.1.34:3443/`(LAN),填写显示名,
勾选"自动应答"可选,点击"连接"。

### 4. 启动终端 TUI 客户端

需要安装 ffmpeg + ALSA(仅 Linux,macOS/WSL 缺声卡驱动):

```bash
sudo apt install ffmpeg alsa-utils
# 启动(自动应答)
npm run start:tui-auto
# 或:node packages/client-tui/src/index.js --auto-answer

# 自定义名称
node packages/client-tui/src/index.js --name "TUI-Alice"
# 指定音频设备(arecord -l / aplay -l 查看)
node packages/client-tui/src/index.js --capture hw:0,0 --playback hw:0,0

# HTTPS server 时 TUI 也必须用 wss://
node packages/client-tui/src/index.js --server wss://192.168.1.34:3443 --name "tui-A"

# 音频后端: auto (默认,优先 pulse) | alsa | pulse
# pulse 让多 TUI 共享设备(需要先装 pulseaudio 或 pipewire-pulse)
node packages/client-tui/src/index.js --audio-backend pulse
```

TUI 客户端按键:

| 键 | 功能 |
|----|------|
| `↑/↓` | 在在线列表中选择 |
| `Enter` | 确认选择 |
| `C` | 发起语音呼叫(终端强制为语音) |
| `V` | 发起视频呼叫(终端降级为语音) |
| `A` | 接听来电 |
| `R` | 拒绝来电 |
| `H` | 挂断当前通话 |
| `M` | 切换本地静音 |
| `L` | 查看通话记录 |
| `U` | 切换自动应答(重新连接后生效) |
| `Q` | 退出 |

## 通话测试

### 浏览器 ↔ 浏览器(同网络)

开两个浏览器窗口(普通 + 隐身),都访问同一个 server URL,选对方 → 语音/视频通话。WebRTC P2P,听到彼此。

### 浏览器 ↔ TUI(中继模式)

1. 浏览器打开 `https://192.168.1.34:3443/`(或 http://localhost:3000/),点"连接"
2. 终端启动 TUI,确保 server URL 与浏览器一致
3. TUI 用 `↑/↓` + `Enter` 选中浏览器那一行
4. 按 `C` 发起呼叫
5. 浏览器弹出来电 → 点"接听"
6. 双方听到声音(中继传输 PCM)
7. TUI 按 `M` 静音/恢复,`H` 挂断

TUI↔Browser 永远走中继(终端无 WebRTC 栈),所以浏览器听到的声音由 server 转发 PCM 帧实现。

### TUI ↔ TUI(中继模式)

两台机器各起一个 TUI,连同一 server,选对方 → `C` 接听即可。两端都用 `ffmpeg + ALSA`。


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
| `relay-audio` | C→S→C | 中继音频帧(`encoding: 'pcm-s16le'` 48k mono,base64) |
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
npm run test:unit         # 单元 + 集成(Node --test)
npm run test:e2e          # 浏览器端到端(需要 Playwright)
npm run test:all          # 全部
```

E2E 覆盖:

1. 服务端注册 + 在线列表
2. Browser↔Browser P2P 通话(ICE connected)
3. 静音控制(mute button + DataChannel)
4. 挂断 + 通话记录
5. Browser↔TUI 中继模式(自动应答 + 音频帧转发)

## 已知限制

- 终端 TUI 不支持视频(只接听/发起音频)
- 终端 TUI 通话默认走中继模式(终端无法做 WebRTC SDP/ICE)
- **同机默认只跑一个 TUI**——ALSA 设备一次只能被一个进程独占;第二个 TUI 启动时 ffmpeg 会 `Device or resource busy` 然后退出。TUI ↔ 浏览器 / TUI ↔ 不同机的 TUI 都不受影响(浏览器走 PulseAudio/PipeWire,不同机 TUI 占不同硬件)
- **安装 PulseAudio(或 PipeWire-Pulse)可解除此限制**:`sudo apt install pipewire pipewire-pulse wireplumber` 或 `sudo apt install pulseaudio`,然后 `node packages/client-tui/src/index.js --audio-backend pulse`(默认会自动检测 pulse 是否可用,可用就优先用)
- 通话记录仅在内存,服务重启丢失
- 浏览器无 STUN 失败自动 TURN 降级(中继 fallback 是 fallback)
- 自动应答模式仅接听音频,拒绝视频
- 浏览器在非安全上下文(http:// 非 loopback)不能访问麦克风/摄像头,需用 https 或 localhost;会在 UI 给出明确提示
- TUI 中继走 PCM(不经 opus),两端都需能写读 s16le 48k mono;带宽 ~96KB/s/stream
- 自签证书首次访问需在浏览器手动信任;生产请用正规 CA 证书

## 测试场景组合

| 客户端 A | 客户端 B | 路径 | 备注 |
|---------|---------|------|------|
| 浏览器 | 浏览器(同机) | P2P(ICE) | 同机多浏览器 OK |
| 浏览器 | 浏览器(异机) | P2P(ICE) 或中继 | 看网络 |
| 浏览器 | TUI(同机或异机) | 中继(PCM) | 永远中继 |
| TUI | TUI(异机) | 中继(PCM) | OK |
| TUI | TUI(**同机**) | ❌ 不可用(默认) / ✓ (用 `--audio-backend pulse`) | ALSA 设备冲突;装 pulseaudio 或 pipewire-pulse 后可解除 |
| 浏览器(同机) | 浏览器 | + 多个 TUI(异机) | 任意组合 |
