# 维护事项与验证边界

整理日期：2026-10-18。历史审查和构建报告已按“已发布修复 / 后续验证”收敛；本次仅整理文档，没有重新执行构建、漏洞扫描或部署。

## 已发布修复

- [0.3.1](RELEASE_0.3.1.md)：依赖、工具链、镜像和多架构构建更新；包含当时的版本表与扫描结果。
- [0.3.2](RELEASE_0.3.2.md)：可信代理链解析、离线 resume 有限保留、防重放前缀容量、独立 KDF Worker、非空 token 长度限制和许可分发。
- [0.3.3](RELEASE_0.3.3.md)：媒体 SDK 按需加载、过期会话清理、官方 npm registry 与脚本策略。保留默认 500 kB 检查及约 523 kB 上游 SDK 提示，不抬高阈值隐藏告警。

## 待验证或单独设计

- 真实 nginx/Docker 的来源地址与可信代理配置。只信任实际代理地址/网段，从右向左解析链，不能把整个私网默认视为可信。
- 大规模同时 join/resume、全局锁/SQLite 持锁时间、融合去重缓存内存上界与媒体出口容量。先测量再改变索引、配额或持久化语义。
- 超过 128 个发送前缀的换钥/容量方案，禁止普通 LRU 淘汰旧防重放状态。
- 非流式请求超时、代理 body 限制、TLS/HSTS/CSP 部署策略；更改不能破坏 WS/流式事件通道。
- 网页本地化与读屏、受鉴权保护的运行指标、镜像扫描及例外处理流程。
- 发布包许可内容、实际反向代理、LiveKit 媒体路径、跨手机音频及 RF 表现，需部署/设备验收。

禁麦控制音频发布，仍允许文字不是权限漏洞；反刷屏需独立设计。前端必须先构建供 Go embed 使用，不用占位页面掩盖缺失资源。服务端发布标签不等于用户实例已经部署。

## 检查入口

在仓库根目录执行（顺序与 [CI](../.github/workflows/ci.yml) 一致）：

```sh
npm --prefix frontend ci
npm --prefix frontend run build
npm --prefix frontend test
node webtests/client_crypto_test.mjs
go test -race ./...
go vet ./...
npm --prefix frontend run test:browser
```

浏览器测试需要已安装 Playwright Chromium。Go 模块一致性、漏洞扫描及 Linux amd64/arm64 构建详见 CI。各正式版记录中的通过数和零漏洞结果仅代表当次检查。
