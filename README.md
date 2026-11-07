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

## Docker Compose 部署

复制环境变量模板并填写 LiteLLM 配置，同时设置 PostgreSQL 密码：

```bash
cp .env.example .env
# 编辑 .env，至少填写 LITELLM_API_BASE、LITELLM_API_KEY 和 POSTGRES_PASSWORD
# LiteLLM 若运行在宿主机，将 API 地址设为 http://host.docker.internal:4000
```

构建镜像并在后台启动 Dashboard、PostgreSQL 和 Redis：

```bash
docker compose up -d --build
```

打开 `http://localhost:3001`。常用维护命令：

```bash
docker compose logs -f app          # 查看应用日志
docker compose ps                   # 查看容器状态
docker compose restart app          # 重启应用
docker compose down                 # 停止并移除容器，保留数据卷
docker compose down -v              # 停止并删除数据卷（会删除持久化数据）
```

应用镜像通过多阶段 Dockerfile 构建；Compose 将 PostgreSQL、Redis 和应用数据分别存入命名卷。更改依赖或代码后重新执行 `docker compose up -d --build`。

## Docker Compose 开发模式

开发模式会把当前目录挂载到应用容器中，前端由 Vite 提供热更新，服务端由 `tsx watch` 自动重启；PostgreSQL 和 Redis 同时启动并提供给应用使用。将 `.env.example` 复制为 `.env` 并填入 LiteLLM 配置后运行：

```bash
docker compose -f docker-compose.dev.yml up --build
```

打开 `http://localhost:5173`。应用 API 位于 `http://localhost:3001`；PostgreSQL 和 Redis 也分别映射到宿主机的 `5432` 和 `6379`。依赖变更后重新构建开发镜像：

```bash
docker compose -f docker-compose.dev.yml up --build
```

停止开发环境使用 `docker compose -f docker-compose.dev.yml down`。开发数据保存在独立的 `dev_postgres_data` 和 `dev_redis_data` 卷中，不会与生产 Compose 数据混用。

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
| `DATABASE_URL` | PostgreSQL 连接串；配置后模型健康状态存入 PostgreSQL | Compose 自动设置 |
| `REDIS_URL` | Redis 连接串；配置后启用用量查询缓存 | Compose 自动设置 |
| `POSTGRES_PASSWORD` | Compose 初始化 PostgreSQL 使用的密码 | 必须在 `.env` 中设置 |
| `MODEL_HEALTH_INTERVAL_MINUTES` | 模型健康检查默认间隔（分钟），UI 保存值会覆盖默认值 | `15` |
| `MODEL_HEALTH_INCLUDE_MODELS` | 只检查匹配的模型名（逗号分隔，支持 `*` 和 `?`；留空表示全部） | — |
| `MODEL_HEALTH_EXCLUDE_MODELS` | 排除匹配的模型名；排除规则优先 | — |
| `MODEL_HEALTH_TIMEOUT_MS` | 单个部署连接检查超时（毫秒） | `30000` |
| `MODEL_HEALTH_CONCURRENCY` | 同时进行的连接检查数 | `4` |
| `WEWORK_WEBHOOK_URL` | 企业微信机器人 Webhook 初始值，可在模型健康页面配置 | — |

## 模型健康监控

服务启动后会读取 LiteLLM `/model/info`，按环境变量规则过滤模型，再通过 `/health/test_connection` 逐个检查部署。模型组至少一个部署健康时显示可用，部分部署失败显示部分异常，所有部署失败显示不可用。首次无历史数据时会立即检查，此后按配置间隔执行。

检查结果和告警事件默认写入本机 `data/model-health.json`，默认保留 60 天；设置 `DATABASE_URL` 后由 PostgreSQL 持久化。首次启用数据库时会把已有 JSON 状态导入 PostgreSQL。Redis 缓存用量 API 响应（最近 7 天缓存 60 秒，趋势缓存 5 分钟），并开启 AOF；缓存失效时会回源 LiteLLM。模型健康页可配置检查间隔、企业微信 Webhook 和告警关注模型，空的关注列表表示全部模型。Webhook 地址只由服务端读取和发送；页面配置接受企业微信机器人提供的 HTTPS 地址。记录的毫秒数是 Dashboard 到 LiteLLM 健康检查接口的总耗时，并不代表 TTFT 或纯上游耗时。

当前定时任务适用于单个服务实例；运行多个 Dashboard 实例会重复检查。
