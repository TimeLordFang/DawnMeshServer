# 客户端能力与公告配置

适用于 Server 0.3.0 及后续正式版，字段实现见 [client_features.go](../internal/server/client_features.go)。普通公网房只使用 LiveKit，独立融合房见 [融合房说明](FUSION_ROOMS.md)。

## 生效方式

`GET /api/v1/info` 返回 `features`，当前 `schemaVersion` 为 1。设置 `DAWNMESH_CLIENT_FEATURES_FILE=/path/client-features.json` 后，每次 info 请求读取文件。先写临时文件，再原子重命名替换；客户端联网时约每 30 秒轮询，无需重启服务。

```json
{
  "schemaVersion": 1,
  "hybridAudio": false,
  "hybridMaxPeers": 4,
  "hybridMaxRttMs": 120,
  "hybridStableSamples": 3,
  "hybridMaxLossPercent": 3,
  "hybridMaxJitterMs": 40,
  "notice": "服务器维护公告"
}
```

## 字段与兼容规则

| 字段 | 校验规则与用途 |
| --- | --- |
| `schemaVersion` | 必须为 1 |
| `hybridAudio` | 服务端始终返回 false，配置 true 也不能恢复旧公网融合 |
| `hybridMaxPeers` | 1–4，旧协议兼容字段，不代表独立融合房的人数上限 |
| `hybridMaxRttMs` | 40–300 ms，旧直连质量参数 |
| `hybridStableSamples` | 3–10，旧直连稳定样本数 |
| `hybridMaxLossPercent` | 0–20，省略时默认 3 |
| `hybridMaxJitterMs` | 5–200 ms，省略时默认 40 |
| `notice` | 最多 600 UTF-8 字节，由已实现该能力的客户端展示 |

未配置路径时返回默认参数；文件不可读、字段越界、schema 不支持或 JSON 含多余尾部内容时回退默认配置，旧融合始终关闭。配置不能修改独立融合房的 16 人容量、签名验证或中继恢复规则。

旧的 `PUT /api/v1/rooms/{room}/hybrid-audio` 开启请求返回 409，关闭旧偏好仍允许调用，详见 [API](API.md)。这些字段是数据配置，不提供任意原生代码热更新。新的原生功能、协议或界面需要发布客户端；中继实现更新需要重新部署服务端。
