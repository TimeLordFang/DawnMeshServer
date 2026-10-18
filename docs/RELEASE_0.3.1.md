# DawnMesh Server/Web 0.3.1

在 0.3.0 的公网房和融合中继功能基础上，更新稳定版依赖和构建镜像。

- Web：LiveKit 2.22.4、Vite 8.3.4、Playwright 1.64.0、Node 26.11.1 / npm 12.2.0；锁定文件使用 npm 官方源。
- Go 1.27.2、LiveKit protocol 1.52.1 / server SDK 2.19.0、SQLite 1.60.1 及最新兼容运行依赖。
- 镜像：LiveKit server 1.13.9、Alpine 3.24.2；Buildx 0.38.0 / BuildKit 0.34.0；Actions 固定官方稳定发行，runner 使用 Ubuntu 26.04 GA。
- 保留现有协议；Go 交叉编译 amd64/arm64，构建阶段使用宿主架构镜像。

已通过 17 项浏览器回归、加密向量、Go 竞态检测/vet、漏洞扫描、真实 Android/iOS 融合中继及两架构容器构建。
配套 Android 1.1.1 与 iOS 1.0.0，兼容原 Android 1.1.0。部署仍由服务器管理者更新二进制或镜像。

## 2026-10-13 稳定版依赖更新

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
