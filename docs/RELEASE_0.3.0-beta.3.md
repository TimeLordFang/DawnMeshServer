# DawnMesh Server 0.3.0-beta.3

配套 Android 1.1.0-beta.4，功能清单新增 `hybridMaxLossPercent`（默认 3，范围 0–20）及 `hybridMaxJitterMs`（默认 40，范围 5–200）。动态配置文件原子替换后，下次客户端轮询生效，无需重启服务。旧配置省略新增字段仍保留默认值，无效值禁用融合。

本版同时包含上个标签后已修复的 Go 模块分类：测试直接引用 protobuf，因此将其标记为直接依赖，CI 与 Release 都检查 `go mod tidy` 是否产生差异。

客户端 beta.4 改为健康直连优先，公网断开时保留已建立的直连与共用采集。该客户端修复无法只靠服务端热配置下发；Server beta.2 仍能提供兼容默认值。详见 [动态能力](CLIENT_FEATURES.md) 与 [多人拓扑边界](WIFI_MESH_TOPOLOGY.md)。未实现跨群组多跳 Mesh。

发布仅推送主分支与标签，不跟踪 Actions 或声称线上服务器已自动部署。

验证：Go 全量竞态测试、vet、go mod tidy 一致性、已调用代码漏洞扫描通过；网页构建、4 项单测、加密向量与 17 项浏览器回归通过；Linux amd64/arm64 发行包构建成功。
