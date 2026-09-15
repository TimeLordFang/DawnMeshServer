# DawnMesh Server（曙光之声服务端）

[English](README.en.md) · [发行版](https://github.com/TimeLordFang/DawnMeshServer/releases) · [容器镜像](https://github.com/TimeLordFang/DawnMeshServer/pkgs/container/dawnmeshserver)

[![CI](https://github.com/TimeLordFang/DawnMeshServer/actions/workflows/ci.yml/badge.svg)](https://github.com/TimeLordFang/DawnMeshServer/actions/workflows/ci.yml)
[![Release](https://github.com/TimeLordFang/DawnMeshServer/actions/workflows/release.yml/badge.svg)](https://github.com/TimeLordFang/DawnMeshServer/actions/workflows/release.yml)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)

DawnMesh Server 是「曙光之声」公网对讲模式的自托管控制平面。它使用 SQLite 保存房间元数据，转发客户端之间的 SPAKE2 入房验证，执行房主管理策略，并签发短时、最小权限的 LiveKit 令牌。语音和聊天内容默认只由客户端持有的 LiveKit E2EE 密钥保护；房主也可以在建房时明确允许自部署服务器管理员实时收听。

本项目不申请或续期 HTTPS 证书。API 和 LiveKit 信令可以接入已有 Nginx，由 Nginx 完成 TLS 卸载。

## 功能

- 一个房间默认最多 25 人，可通过 `DAWNMESH_MAX_PARTICIPANTS` 调整
- 六位邀请码经 SPAKE2 验证，不进入 HTTP 请求、房间元数据、JWT 或服务端日志
- 房主可修改房间名、关闭或恢复成员麦克风，并主动解散房间
- 房主创建房间时可设置 1–60 分钟的最大断线保留时间
- 房主超时后自动转让给最早在线成员；空房在最后一人离线 10 分钟后清理
- SQLite 持久化房间控制状态；音视频媒体由 LiveKit 处理
- 单二进制内置 `/client/` 网页对讲客户端和 `/admin/` 管理后台
- 房主授权后，管理员可在后台通过端到端加密的只听连接实时收听；房内会持续显示监听状态

## 部署要求

- Linux `amd64` 或 `arm64` 服务器
- Docker Engine 与 Docker Compose，或 Go 1.27.1+
- API 和 LiveKit 信令使用的公网域名
- UDP 57882 与 TCP 57881 可公网访问，或有等价的四层转发
- 已配置的 Nginx HTTPS 入口

## 使用容器镜像部署

克隆仓库后生成配置：

```bash
cp config.example.env .env
cp livekit.example.yaml livekit.yaml
# 也可以自动生成随机实例 ID、访问令牌和 LiveKit 凭据：
./scripts/init-config.sh
```

编辑 `.env` 和 `livekit.yaml`。两处 LiveKit API key/secret 必须一致。将 `DAWNMESH_PUBLIC_URL` 设为 API 的 HTTPS 地址，将 `LIVEKIT_PUBLIC_URL` 设为 LiveKit 信令的公网 `wss://` 地址。LiveKit 使用 host network；Compose 会把 DawnMesh Server 容器内的 `livekit` 主机名映射到宿主机网关，因此原有的 `LIVEKIT_URL=http://livekit:7880` 可以继续使用。

```bash
docker compose pull
docker compose up -d --no-build
curl -fsS https://talk.example.com/healthz
```

默认镜像是 `ghcr.io/timelordfang/dawnmeshserver:latest`。如需固定版本，在 `.env` 中设置：

```dotenv
DAWNMESH_IMAGE=ghcr.io/timelordfang/dawnmeshserver:1.0.0
```

首次发布后，请在 GitHub 的 Package settings 中把容器包可见性设为 **Public**，这样未登录用户才能直接拉取；这是 GHCR 包的一次性仓库设置。

如需从源码构建镜像：

```bash
docker compose up -d --build
```

将 [`deploy/nginx.example.conf`](deploy/nginx.example.conf) 中需要的部分加入现有 Nginx 配置。`/api/` 应允许 WebSocket 升级，并必须转发原始 `Host`、`Origin` 和 `Sec-WebSocket-Protocol`；后者携带浏览器管理通道的临时凭证。服务端每 20 秒发送一次 WebSocket 心跳。若代理仍拒绝升级，网页端会自动切换到带鉴权请求头的 HTTPS 流式管理通道。Nginx 返回 `401` 通常表示凭证请求头未转发，`403` 通常表示 `Host` 与 `Origin` 不一致。优先直通 UDP 57882 和 TCP 57881；HTTPS 健康检查成功只代表控制平面可用，不代表 WebRTC 媒体链路可用。

最后在 Android 客户端的网络对讲页面添加 `DAWNMESH_PUBLIC_URL`，并输入 `DAWNMESH_ACCESS_TOKEN`。

## 网页对讲客户端

部署完成后打开 `https://talk.example.com/client/`。网页端使用当前服务器，不需要另外填写服务地址；如果配置了 `DAWNMESH_ACCESS_TOKEN`，首次进入时输入该访问凭证即可。

网页客户端与 Android 公网房使用同一套协议和房间：

- 创建、发现和使用六位邀请码加入房间
- P-256 SPAKE2 邀请码验证，邀请码不发送给服务器
- LiveKit WebRTC 语音与 E2EE、加密文字消息
- 按住说话和自动通话、清晰/平衡/省流三档音质
- 成员头像、发言状态和稳定的加入顺序
- 房主改名、成员封麦/开麦、转让房主和解散房间
- 管理通道优先使用 WebSocket，并在代理拒绝升级时自动切换到普通 HTTPS 流；媒体断线时独立刷新短时令牌，并在十分钟成员保留窗口内自动恢复
- 响应式桌面和移动端布局

浏览器麦克风和 Web Crypto 要求 HTTPS 安全上下文；`localhost` 仅用于本地开发。Safari、Chrome、Edge、Firefox 对 WebRTC E2EE、音频后台运行和输出设备切换的支持存在差异。移动浏览器进入锁屏或被系统回收后无法提供与 Android 前台服务相同的后台持续性，长时间对讲仍建议使用 Android App。网页端的 WebSocket 凭证通过 `Sec-WebSocket-Protocol` 请求头传递，Nginx 等反向代理不要记录该请求头。

访问凭证只写入当前标签页的 `sessionStorage`，昵称和随机设备标识写入 `localStorage`。邀请码、房间密钥和成员恢复令牌只保存在页面内存中；刷新或关闭页面后不会恢复这些敏感值。

## 管理后台

打开 `https://talk.example.com/admin/`，输入 `.env` 中的 `DAWNMESH_ADMIN_TOKEN`。初始化脚本会自动生成独立的管理员凭证；它必须至少包含 32 个字符，并且不能与提供给手机端的 `DAWNMESH_ACCESS_TOKEN` 相同。

后台静态页面通过 Go `embed` 编入 `dawnmesh-server` 二进制，不需要部署 Node.js、静态目录或额外 Web 服务。页面支持：

- 查看服务运行时间、房间数、在线及保留成员数
- 查看房主、成员在线状态、重连截止时间和待验证人数
- 修改房间名称
- 关闭或恢复非房主成员的麦克风权限
- 立即解散房间
- 实时收听房主已授权的房间
- 每 10 秒自动刷新，也可以手动刷新

管理员凭证只保存在当前标签页的 `sessionStorage`，通过 `Authorization: Bearer` 请求头发送，不进入 URL 和 Cookie。未配置 `DAWNMESH_ADMIN_TOKEN` 时管理 API 会保持禁用。建议只通过 HTTPS 开放后台，并在 Nginx 上按需增加 IP 白名单或额外认证。

实时收听默认关闭。房主建房时开启后，App 才会把房间 E2EE 密钥交给服务器；服务器使用由 `DAWNMESH_ADMIN_TOKEN` 派生的 AES-GCM 密钥加密后写入 SQLite。监听者使用隐藏、只订阅且不能发言的短时 LiveKit 凭证，需每 10 秒续租；断开或浏览器关闭后最多约 35 秒自动失效。监听期间所有房间成员都会收到并显示状态。更换管理员令牌会使已有房间的托管密钥失效。

## 使用二进制部署

每个 `v*` 标签会在 [GitHub Releases](https://github.com/TimeLordFang/DawnMeshServer/releases) 生成 Linux `amd64`、`arm64` 压缩包和 `SHA256SUMS`。校验并安装：

```bash
sha256sum -c SHA256SUMS
install -m 0755 dawnmesh-server /usr/local/bin/dawnmesh-server
```

进程需要读取与 `config.example.env` 对应的环境变量，并对 `DAWNMESH_DATABASE` 所在目录具有写权限。LiveKit 仍需单独运行。

## TURN 与网络端口

LiveKit 容器使用 host network，直接监听宿主机的 IPv4 与 IPv6 通配地址。实时语音优先使用 UDP 57882，ICE/TCP 57881 是回退链路；宿主机防火墙和云安全组必须同时为所需地址族放行。`use_external_ip: true` 会自动探测一个公网地址；需要同时公布固定公网 IPv4 和 IPv6 时，改为 `use_external_ip: false`，并设置 `node_ip: "公网IPv4,公网IPv6"`。

如果需要兼容同时封锁 UDP 和 ICE/TCP 的网络，可以开启 LiveKit 的认证 TURN。TURN/TLS 是四层协议，不能放进 Nginx 的 HTTP `location`；可使用独立公网端口/IP，或在确认客户端 SNI 行为后使用 Nginx `stream` 分流。由 Nginx 终止 TURN TLS 时，需要在 LiveKit 中设置 `turn.external_tls: true`。

## 状态恢复规则

- 普通成员意外断线后保留身份 10 分钟。
- 房主在创建房间时选择 1–60 分钟，默认 10 分钟。
- 房主超时且仍有成员在线时，房主身份转让给最早在线成员。
- 房间完全空置后 10 分钟删除，即使房主设置了更长时间。
- 房主主动解散房间时立即删除。

SQLite 数据保存在 `dawnmesh-data` 卷中。备份时同时保存数据库、`.env` 和 `livekit.yaml`。邀请码和聊天内容不会写入 SQLite；仅当房主主动允许管理员收听时，服务器才会保存由管理员令牌加密封装的 E2EE 房间密钥。

## 安全说明

新的 LiveKit 入房令牌默认禁止发布音频。客户端建立经过认证的管理通道后，服务端才把当前持久化的发言策略应用到参与者；重放旧令牌不能恢复已被关闭的麦克风权限。令牌有效期为两分钟，API 密钥只保存在服务端。

六位邀请码不适合作为公网服务的唯一访问凭据，请为 `DAWNMESH_ACCESS_TOKEN` 使用高熵随机值。`DAWNMESH_ADMIN_TOKEN` 还用于保护房主主动托管的监听密钥，必须单独保管，不能发送给普通 App 用户。公网部署还应限制数据库和配置文件权限，并定期更新镜像。

协议细节见 [`docs/API.md`](docs/API.md)。API 协议版本为 `v1`；Android 客户端会拒绝不兼容的协议版本，并检测服务实例 ID 的意外变化。

## 开发与验证

```bash
go test -race ./...
go vet ./...
go install golang.org/x/vuln/cmd/govulncheck@v1.8.0
govulncheck ./...
```

推送到 `main` 或创建 Pull Request 时，CI 会执行模块一致性检查、竞态测试、`go vet`、漏洞扫描和 Linux 双架构编译。推送 `v*` 标签时，Release 工作流会发布二进制压缩包、SHA-256 校验文件和 GHCR 多架构容器镜像。Dependabot 每周检查 Go 模块、Docker 基础镜像和 GitHub Actions。

```bash
git tag -a v0.1.0 -m "DawnMesh Server v0.1.0"
git push origin v0.1.0
```

## 开源协议

DawnMesh Server 使用 [GNU Affero General Public License v3.0](LICENSE)（`AGPL-3.0-only`）。通过网络向用户提供本软件功能时，如果修改了本项目，AGPL 要求向这些用户提供对应源代码。LiveKit 及其他依赖继续使用各自的开源协议。
