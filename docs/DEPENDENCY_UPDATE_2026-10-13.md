# 2026-10-13 稳定版依赖更新

| 依赖/工具 | 版本 |
| --- | --- |
| Node / npm | 26.11.1 / 12.2.0 |
| livekit-client | 2.22.4 |
| Playwright | 1.64.0 |
| @types/node | 26.6.5 |
| Vite / TypeScript | 8.3.4 / 7.0.2 |
| Go toolchain | 1.27.2 |
| LiveKit Go protocol / server SDK | 1.52.1 / 2.19.0 |
| SQLite | 1.60.1 |
| Pion WebRTC | 4.2.23 |
| LiveKit server 镜像 | v1.13.9 |
| Alpine | 3.24.2 |
| Buildx / BuildKit | 0.38.0 / 0.34.0 |
| govulncheck | 1.9.0 |
| CI runner | Ubuntu 26.04 GA |

Go 和 npm 锁定文件均重新生成，直接及 go.mod 要求的传递依赖升级到最新稳定版。
保留最低 Node 24 的运行要求，构建和 Actions 使用最新稳定 Node 26。
所有 Actions 固定官方稳定 release commit。Docker 构建阶段使用 BUILDPLATFORM，
通过 Go 交叉编译生成 amd64/arm64，避免执行错误架构的 Node/Go 镜像。
新增不发布镜像的两架构 CI 构建；Dependabot 补充 npm 周更。

验证：前端类型检查/生产构建、4 项 Node 测试、17 项 Chromium 浏览器回归、
Dart 对应的浏览器加密向量、Go 竞态测试/go vet、Linux amd64/arm64 交叉编译。

govulncheck 1.9.0：实际导入包和可达调用均为 0 个漏洞。模块级记录
GO-2026-5932 指向 golang.org/x/crypto 中未维护的 openpgp 包；本项目不导入该包，
上游暂无修复版本。https://pkg.go.dev/vuln/GO-2026-5932

来源：npm registry、Go proxy、https://nodejs.org/dist/index.json、
https://go.dev/dl/?mode=json、https://github.com/livekit/livekit/releases/latest、
https://dl-cdn.alpinelinux.org/alpine/latest-stable/releases/aarch64/latest-releases.yaml、
npm 审计结果为 0 个漏洞，锁定文件使用官方 npm registry 下载地址。
各 Actions、Buildx 和 BuildKit 的 GitHub 官方稳定发行记录。
