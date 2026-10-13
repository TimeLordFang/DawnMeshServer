# DawnMesh Server/Web 0.3.1

在 0.3.0 的公网房和融合中继功能基础上，更新稳定版依赖和构建镜像。

- Web：LiveKit 2.22.4、Vite 8.3.4、Playwright 1.64.0、Node 26.11.1 / npm 12.2.0；锁定文件使用 npm 官方源。
- Go 1.27.2、LiveKit protocol 1.52.1 / server SDK 2.19.0、SQLite 1.60.1 及最新兼容运行依赖。
- 镜像：LiveKit server 1.13.9、Alpine 3.24.2；Buildx 0.38.0 / BuildKit 0.34.0；Actions 固定官方稳定发行，runner 使用 Ubuntu 26.04 GA。
- 保留现有协议；Go 交叉编译 amd64/arm64，构建阶段使用宿主架构镜像。

已通过 17 项浏览器回归、加密向量、Go 竞态检测/vet、漏洞扫描、真实 Android/iOS 融合中继及两架构容器构建。
配套 Android 1.1.1 与 iOS 1.0.0，兼容原 Android 1.1.0。部署仍由服务器管理者更新二进制或镜像。

版本与上游约束明细见 [依赖更新记录](DEPENDENCY_UPDATE_2026-10-13.md)。
