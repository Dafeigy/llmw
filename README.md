# LiteLLM 模型健康监控

FastAPI 服务定时调用 LiteLLM `GET /health`，将部署状态保存到 SQLite，并通过企业微信群机器人 webhook 只推送状态变化。

## 行为

- 首次成功查询只建立基线，不发送模型告警；重启后从 SQLite 中的最新状态继续比较。
- 按 `model_id` 区分同名模型的多个部署。推送新增异常、恢复、异常类型或 HTTP 状态变化，以及部署移除；没有变化时不发消息。
- LiteLLM 查询失败时保留最后一次有效模型快照，只推送一次接口故障；恢复后推送恢复消息。
- 企业微信发送失败时保留 SQLite 待发消息，每 30 秒重试。HTTP 成功且响应 `errcode == 0` 才算发送成功。
- 群消息只包含模型名、提供方、凭据名称、短 ID、异常类型和状态码，不包含原始错误堆栈、请求头或 API 地址。

## 配置

复制 `.env.example` 为 `.env`，填写 `LITELLM_BASE_URL`、`LITELLM_API_KEY` 和 `WEBHOOK_URL`。检查间隔由 `CHECK_INTERVAL_SECONDS` 控制，示例为 900 秒（15 分钟）。代码中没有默认密钥。

`.env.example` 的 `host.docker.internal` 适用于 LiteLLM 运行在同一台 Linux Docker 主机上；Compose 文件已配置 `host-gateway` 映射。如果 LiteLLM 在另一台机器，改成该机器可从容器访问的 URL。如果它与本服务处于同一个 Docker 网络，可以使用其服务名，例如 `http://litellm:4000`，并将两个容器接入同一网络。容器内的 `localhost` 只指向本容器。

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `CHECK_INTERVAL_SECONDS` | `900` | 两次检查之间的秒数 |
| `LITELLM_TIMEOUT_SECONDS` | `120` | 单次 LiteLLM 请求超时 |
| `WEBHOOK_TIMEOUT_SECONDS` | `10` | 企业微信请求超时 |
| `SQLITE_PATH` | `data/health.sqlite3` | SQLite 文件路径 |

`GET /health` 默认会实际请求每个模型，可能产生 token 成本。若在 LiteLLM 中启用后台健康检查，`/health` 可返回其缓存结果；此时应确认后台检查间隔与本服务间隔符合预期。

## Linux Docker 部署

先准备配置和持久化目录：

```bash
cp .env.example .env
mkdir -p data
```

编辑 `.env`，填入真实网关 URL、LiteLLM API Key 和企业微信群机器人 webhook URL。

使用 Docker Compose 构建并启动：

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f watcher
```

也可以单独构建镜像并运行：

```bash
docker build -t litellm-health-watcher:latest .
docker run -d --name litellm-health-watcher \
  --env-file .env \
  --add-host host.docker.internal:host-gateway \
  -p 127.0.0.1:8000:8000 \
  -v "$(pwd)/data:/app/data" \
  --restart unless-stopped \
  litellm-health-watcher:latest
```

如需将镜像打包后送到另一台 Linux 主机：

```bash
docker save -o litellm-health-watcher.tar litellm-health-watcher:latest
# 在目标主机执行：
docker load -i litellm-health-watcher.tar
docker compose up -d --no-build
```

目标主机还需有 `compose.yaml` 和填写好的 `.env`。`data/` 应保留，以便重启后继续跟踪状态。构建上下文通过 `.dockerignore` 排除了 `.env`、SQLite 数据库和健康检查样本。

查看服务状态：

```bash
curl http://localhost:8000/healthz
curl http://localhost:8000/status
```

Compose 将端口仅绑定到宿主机的 `127.0.0.1`。如需从其他机器访问状态接口，请自行通过反向代理暴露并设置访问控制。

## 不使用 Docker

安装依赖后运行：

```bash
python -m pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000 --workers 1
```

直接运行时，需先把 `.env` 中的变量注入进程环境；服务不会自动读取 `.env` 文件。此时把 `SQLITE_PATH` 改为本机可写路径。

只运行一个服务实例和一个 Uvicorn worker，避免重复检查与重复推送。持久化部署时保留 `data/` 目录。企业微信 webhook 收到消息后、服务写入发送成功标记前若进程崩溃，重启后可能重发该条消息。

## 测试

```bash
python -m unittest discover -s tests -v
```

测试直接使用仓库中的 `模型健康-response.json`，不会请求真实 LiteLLM 或企业微信接口。
