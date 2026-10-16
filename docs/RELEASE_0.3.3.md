# DawnMesh Server/Web 0.3.3

规范 Web 依赖安装和媒体代码加载，继续兼容 Android 1.1.3 / iOS 1.0.2。

- 房间列表和管理控制台不再提前加载整个 LiveKit SDK；进入语音房或开始收听时按需加载，并保留 tree-shaking。
- 异步加载后重新核对当前会话；麦克风轨道在等待前保持关闭，过期会话释放采集，管理员在 SDK 加载成功后才申请收听身份。
- 恢复 Vite 默认 500 kB 体积检查，不再把阈值提高到 2 MB。上游预打包 SDK 仍约 523 kB，保留这一条可见提示，不修改 SDK 或加密 worker。
- 明确 Web 包版本为 0.3.3，锁定 npm 12 的可选 fsevents 脚本策略；根目录和 frontend 的 npm 调用都使用官方 registry，避免镜像缺少审计接口而误判。

验证：TypeScript/Vite 构建、5 项 Node 回归、共同加密向量、21 项 Chrome 浏览器回归、Go 竞态测试与 vet、go mod tidy -diff、Linux amd64/arm64 编译通过。新增浏览器用例确认房间列表和管理台正常可用且不加载媒体 SDK。
官方 registry 的生产依赖审计结果为 0 个已知漏洞；没有禁用整体依赖脚本保护或提高体积阈值。

媒体与控制协议未变更；两个移动端均通过同一真实 Go 融合中继测试。实际 Docker/nginx 部署、跨手机音频及 RF 表现仍需单独验收。
