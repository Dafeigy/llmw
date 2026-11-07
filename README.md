# LiteLLM 用量控制台

基于 ShadCN 官方 `dashboard-01` block、React、Vite 和 Tailwind CSS 4 构建的 LiteLLM 用量 Dashboard。侧边栏、顶部栏、指标卡、交互趋势图和每日明细表沿用 block 结构。

## 本地运行

1. 将 `.env.example` 中的配置填入本地 `.env`。模型健康监控还要求 LiteLLM Key 可读取 `/model/info` 并调用 `/health/test_connection`；仅有统计读取权限的 key 可能无法运行主动检查：

   ```dotenv
   LITELLM_API_BASE=http://localhost:4000
   LITELLM_API_KEY=sk-your-litellm-key
   PORT=3001
   ```

2. 安装依赖并启动：

   ```bash
   npm install
   npm run dev
   ```

3. 打开 Vite 输出的地址（默认为 `http://localhost:5173`）。

生产构建使用 `npm run build`，之后可通过 `npm start` 启动服务端。

## 数据来源

- 今日与近 7 天的 Token、花费、请求数，以及趋势图：LiteLLM `/user/daily/activity/aggregated`
- 趋势数据使用按日聚合结果，避免逐页读取 spend logs 时漏掉分页外的请求；该接口的请求数仍来源于 spend logs，统计记录到的请求尝试，可能与网关入口请求数不同
- 热力图始终展示当前自然年；折线图支持预设和自定义日期范围
- 服务端每 60 秒拉取一次；浏览器不接触 LiteLLM API Key

此版本不依赖 `/global/spend/report`（LiteLLM Enterprise 功能）或部分旧版缺少的 `/gateway/daily/activity`。若要查看全平台汇总，请在 `.env` 中配置具备完整统计查看权限的 LiteLLM Key。

## 环境变量

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `LITELLM_API_BASE` | LiteLLM Proxy 地址，不带 `/v1` | — |
| `LITELLM_API_KEY` | Dashboard 服务端使用的 LiteLLM Key | — |
| `PORT` | Dashboard 服务端口 | `3001` |
| `MODEL_HEALTH_INTERVAL_MINUTES` | 模型健康检查默认间隔（分钟），UI 保存值会覆盖默认值 | `15` |
| `MODEL_HEALTH_INCLUDE_MODELS` | 只检查匹配的模型名（逗号分隔，支持 `*` 和 `?`；留空表示全部） | — |
| `MODEL_HEALTH_EXCLUDE_MODELS` | 排除匹配的模型名；排除规则优先 | — |
| `MODEL_HEALTH_TIMEOUT_MS` | 单个部署连接检查超时（毫秒） | `30000` |
| `MODEL_HEALTH_CONCURRENCY` | 同时进行的连接检查数 | `4` |
| `WEWORK_WEBHOOK_URL` | 企业微信机器人 Webhook 初始值，可在模型健康页面配置 | — |

## 模型健康监控

服务启动后会读取 LiteLLM `/model/info`，按环境变量规则过滤模型，再通过 `/health/test_connection` 逐个检查部署。模型组至少一个部署健康时显示可用，部分部署失败显示部分异常，所有部署失败显示不可用。首次无历史数据时会立即检查，此后按配置间隔执行。

检查结果和告警事件写入本机 `data/model-health.json`，默认保留 60 天；该文件不纳入版本控制。模型健康页可配置检查间隔、企业微信 Webhook 和告警关注模型，空的关注列表表示全部模型。Webhook 地址只由服务端读取和发送；页面配置接受企业微信机器人提供的 HTTPS 地址。记录的毫秒数是 Dashboard 到 LiteLLM 健康检查接口的总耗时，并不代表 TTFT 或纯上游耗时。

当前定时任务适用于单个服务实例；运行多个 Dashboard 实例会重复检查。该版本不依赖 PostgreSQL 或 Redis。
