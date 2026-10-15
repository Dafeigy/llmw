"""Track LiteLLM deployment health changes and notify a WeCom group."""

from __future__ import annotations

import asyncio
import logging
import os
import re
import sqlite3
from contextlib import asynccontextmanager, contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI


LOG = logging.getLogger("litellm_watcher")
CHINA_TZ = timezone(timedelta(hours=8))


def now_text() -> str:
    return datetime.now(CHINA_TZ).strftime("%Y-%m-%d %H:%M:%S %z")


def positive_number(name: str, default: str) -> float:
    value = float(os.getenv(name, default))
    if value <= 0:
        raise ValueError(f"{name} must be greater than zero")
    return value


def env_list(name: str) -> tuple[str, ...]:
    value = os.getenv(name, "")
    return tuple(item.strip() for item in value.split(",") if item.strip())


@dataclass(frozen=True)
class Gateway:
    gateway_id: str
    name: str
    base_url: str
    api_key: str


@dataclass(frozen=True)
class Settings:
    base_url: str
    api_key: str
    webhook_url: str
    database_path: Path
    check_interval: float
    health_timeout: float
    webhook_timeout: float
    gateways: tuple[Gateway, ...] = ()
    webhook_urls: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        # Keep the old constructor usable for integrations and existing tests.
        if not self.gateways:
            object.__setattr__(
                self,
                "gateways",
                (Gateway("gateway-1", "网关 1", self.base_url.rstrip("/"), self.api_key),),
            )
        if not self.webhook_urls:
            object.__setattr__(self, "webhook_urls", (self.webhook_url,))

    @classmethod
    def from_env(cls) -> Settings:
        base_urls = env_list("LITELLM_BASE_URLS") or env_list("LITELLM_BASE_URL")
        api_keys = env_list("LITELLM_API_KEYS") or env_list("LITELLM_API_KEY")
        webhook_urls = env_list("WEBHOOK_URLS") or env_list("WEBHOOK_URL")
        names = env_list("LITELLM_GATEWAY_NAMES")
        missing = []
        if not base_urls:
            missing.append("LITELLM_BASE_URLS (or LITELLM_BASE_URL)")
        if not api_keys:
            missing.append("LITELLM_API_KEYS (or LITELLM_API_KEY)")
        if not webhook_urls:
            missing.append("WEBHOOK_URLS (or WEBHOOK_URL)")
        if missing:
            raise ValueError(f"Missing environment variables: {', '.join(missing)}")
        if len(base_urls) != len(api_keys):
            raise ValueError("LITELLM_BASE_URLS and LITELLM_API_KEYS must contain the same number of items")
        if names and len(names) != len(base_urls):
            raise ValueError("LITELLM_GATEWAY_NAMES must contain one item per gateway")
        gateway_names = names or tuple(f"网关 {index}" for index in range(1, len(base_urls) + 1))
        gateways = tuple(
            Gateway(f"gateway-{index}", name, base_url.rstrip("/"), api_key)
            for index, (name, base_url, api_key) in enumerate(
                zip(gateway_names, base_urls, api_keys), start=1
            )
        )
        return cls(
            base_url=gateways[0].base_url,
            api_key=gateways[0].api_key,
            webhook_url=webhook_urls[0],
            database_path=Path(os.getenv("SQLITE_PATH", "data/health.sqlite3")),
            check_interval=positive_number("CHECK_INTERVAL_SECONDS", "900"),
            health_timeout=positive_number("LITELLM_TIMEOUT_SECONDS", "120"),
            webhook_timeout=positive_number("WEBHOOK_TIMEOUT_SECONDS", "10"),
            gateways=gateways,
            webhook_urls=webhook_urls,
        )


@dataclass(frozen=True)
class Endpoint:
    model_id: str
    model: str
    provider: str
    credential: str
    healthy: bool
    error_type: str = ""
    http_status: int | None = None

    @property
    def reason(self) -> str:
        return f"HTTP {self.http_status or '?'} {self.error_type or 'UnknownError'}"

    @property
    def label(self) -> str:
        details = "/".join(x for x in (self.provider, self.credential) if x)
        suffix = f" ({details})" if details else ""
        return f"{self.model}{suffix} [id:{self.model_id[:8]}]"


def parse_health_response(payload: Any) -> dict[str, Endpoint]:
    """Reject incomplete results so they cannot overwrite the last good snapshot."""
    if not isinstance(payload, dict):
        raise ValueError("health response is not a JSON object")
    result: dict[str, Endpoint] = {}
    for field, healthy in (("healthy_endpoints", True), ("unhealthy_endpoints", False)):
        rows = payload.get(field)
        if not isinstance(rows, list):
            raise ValueError(f"{field} is missing or is not a list")
        count = payload.get("healthy_count" if healthy else "unhealthy_count")
        if count is not None and (type(count) is not int or count != len(rows)):
            raise ValueError(f"{field} count does not match its list")
        for row in rows:
            if not isinstance(row, dict):
                raise ValueError(f"{field} contains a non-object entry")
            model_id = row.get("model_id")
            if not isinstance(model_id, str) or not model_id.strip():
                raise ValueError("deployment is missing model_id")
            if model_id in result:
                raise ValueError(f"duplicate model_id: {model_id}")
            status = row.get("exception_status")
            if status is not None and type(status) is not int:
                raise ValueError("exception_status is not an integer")
            error = row.get("error", "")
            # The raw error may contain stack traces, URLs, and request headers.
            match = re.match(r"(?:litellm\.)?([A-Za-z_][A-Za-z_0-9]*Error)\b", str(error))
            result[model_id] = Endpoint(
                model_id=model_id,
                model=str(row.get("model") or "unknown"),
                provider=str(row.get("custom_llm_provider") or ""),
                credential=str(row.get("litellm_credential_name") or ""),
                healthy=healthy,
                error_type=(match.group(1) if match else "UnknownError") if not healthy else "",
                http_status=status if not healthy else None,
            )
    return result


def change_lines(previous: dict[str, Endpoint], current: dict[str, Endpoint]) -> list[str]:
    new_errors: list[str] = []
    recovered: list[str] = []
    changed_errors: list[str] = []
    removed: list[str] = []
    for model_id, endpoint in current.items():
        old = previous.get(model_id)
        if not endpoint.healthy and (old is None or old.healthy):
            new_errors.append(f"• {endpoint.label}: {endpoint.reason}")
        elif old and not old.healthy and endpoint.healthy:
            recovered.append(f"• {endpoint.label}")
        elif old and not old.healthy and not endpoint.healthy and old.reason != endpoint.reason:
            changed_errors.append(f"• {endpoint.label}: {old.reason} → {endpoint.reason}")
    for model_id, endpoint in previous.items():
        if model_id not in current:
            removed.append(f"• {endpoint.label}")
    lines: list[str] = []
    for title, group in (
        ("🔴 新增异常", new_errors),
        ("🟢 已恢复", recovered),
        ("🟠 异常类型变化", changed_errors),
        ("⚪ 部署已移除", removed),
    ):
        if group:
            lines.extend([f"{title} {len(group)}", *sorted(group)])
    return lines


def message_chunks(lines: list[str], current: dict[str, Endpoint], gateway_name: str) -> list[str]:
    if not lines:
        return []
    healthy = sum(endpoint.healthy for endpoint in current.values())
    footer = f"当前：正常 {healthy} / 异常 {len(current) - healthy}"
    header = f"LiteLLM {gateway_name} 模型健康变化 | {now_text()}"
    chunks: list[str] = []
    parts = [header]
    for line in [*lines, footer]:
        line = line[:350]
        if len("\n".join([*parts, line]).encode("utf-8")) > 1800 and len(parts) > 1:
            chunks.append("\n".join(parts))
            parts = [header, line]
        else:
            parts.append(line)
    chunks.append("\n".join(parts))
    return chunks


class StateStore:
    def __init__(self, path: Path, webhook_count: int = 1):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        if webhook_count <= 0:
            raise ValueError("webhook_count must be greater than zero")
        self.webhook_count = webhook_count
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            self._prepare_schema(db)

    @staticmethod
    def _prepare_schema(db: sqlite3.Connection) -> None:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS metadata (
                key TEXT PRIMARY KEY, value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS outbox (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                content TEXT NOT NULL, created_at TEXT NOT NULL,
                sent_at TEXT
            );
            CREATE TABLE IF NOT EXISTS outbox_delivery (
                outbox_id INTEGER NOT NULL,
                webhook_index INTEGER NOT NULL,
                sent_at TEXT,
                PRIMARY KEY (outbox_id, webhook_index),
                FOREIGN KEY (outbox_id) REFERENCES outbox(id) ON DELETE CASCADE
            );
            """
        )
        columns = {row[1] for row in db.execute("PRAGMA table_info(endpoint_state)")}
        if columns and "gateway_id" not in columns:
            db.execute("ALTER TABLE endpoint_state RENAME TO endpoint_state_legacy")
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS endpoint_state (
                gateway_id TEXT NOT NULL, model_id TEXT NOT NULL,
                model TEXT NOT NULL, provider TEXT NOT NULL, credential TEXT NOT NULL,
                healthy INTEGER NOT NULL, error_type TEXT NOT NULL,
                http_status INTEGER,
                PRIMARY KEY (gateway_id, model_id)
            )
            """
        )
        if columns and "gateway_id" not in columns:
            db.execute(
                """
                INSERT INTO endpoint_state
                    (gateway_id, model_id, model, provider, credential, healthy, error_type, http_status)
                SELECT 'gateway-1', model_id, model, provider, credential, healthy, error_type, http_status
                FROM endpoint_state_legacy
                """
            )
            db.execute("DROP TABLE endpoint_state_legacy")
            db.execute(
                "INSERT OR IGNORE INTO metadata(key, value) "
                "SELECT 'initialized:gateway-1', value FROM metadata WHERE key = 'initialized'"
            )
            db.execute(
                "INSERT OR IGNORE INTO metadata(key, value) "
                "SELECT 'source_failed:gateway-1', value FROM metadata WHERE key = 'source_failed'"
            )
            db.execute(
                "INSERT OR IGNORE INTO metadata(key, value) "
                "SELECT 'last_success_at:gateway-1', value FROM metadata WHERE key = 'last_success_at'"
            )

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=30)
        try:
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def get_meta(db: sqlite3.Connection, key: str, default: str = "") -> str:
        row = db.execute("SELECT value FROM metadata WHERE key = ?", (key,)).fetchone()
        return row[0] if row else default

    @staticmethod
    def set_meta(db: sqlite3.Connection, key: str, value: str) -> None:
        db.execute(
            "INSERT INTO metadata(key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )

    def queue(self, db: sqlite3.Connection, content: str) -> None:
        cursor = db.execute(
            "INSERT INTO outbox(content, created_at) VALUES (?, ?)",
            (content, now_text()),
        )
        db.executemany(
            "INSERT INTO outbox_delivery(outbox_id, webhook_index) VALUES (?, ?)",
            [(cursor.lastrowid, index) for index in range(self.webhook_count)],
        )

    @staticmethod
    def load(db: sqlite3.Connection, gateway_id: str) -> dict[str, Endpoint]:
        rows = db.execute(
            "SELECT model_id, model, provider, credential, healthy, error_type, http_status "
            "FROM endpoint_state WHERE gateway_id = ?",
            (gateway_id,),
        ).fetchall()
        return {
            row[0]: Endpoint(row[0], row[1], row[2], row[3], bool(row[4]), row[5], row[6])
            for row in rows
        }

    def record_success(
        self,
        gateway_id: str | dict[str, Endpoint],
        gateway_name: str = "",
        current: dict[str, Endpoint] | None = None,
    ) -> list[str]:
        if isinstance(gateway_id, dict):
            current = gateway_id
            gateway_id = "gateway-1"
            gateway_name = "网关 1"
        if current is None:
            raise TypeError("current gateway health result is required")
        with self.connect() as db:
            previous = self.load(db, gateway_id)
            initialized = self.get_meta(db, f"initialized:{gateway_id}") == "1"
            source_failed = self.get_meta(db, f"source_failed:{gateway_id}") == "1"
            if initialized and previous and not current:
                raise ValueError(f"empty health result would remove every deployment for {gateway_name}")
            lines = change_lines(previous, current) if initialized else []
            if source_failed:
                lines.insert(0, f"🟢 LiteLLM {gateway_name} 健康检查接口已恢复")
            db.execute("DELETE FROM endpoint_state WHERE gateway_id = ?", (gateway_id,))
            db.executemany(
                "INSERT INTO endpoint_state VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                [
                    (gateway_id, e.model_id, e.model, e.provider, e.credential,
                     int(e.healthy), e.error_type, e.http_status)
                    for e in current.values()
                ],
            )
            self.set_meta(db, f"initialized:{gateway_id}", "1")
            self.set_meta(db, f"source_failed:{gateway_id}", "0")
            self.set_meta(db, f"last_success_at:{gateway_id}", now_text())
            for content in message_chunks(lines, current, gateway_name):
                self.queue(db, content)
            return lines

    def record_failure(
        self, gateway_id: str, gateway_name: str | None = None, reason: str | None = None
    ) -> None:
        if reason is None:
            reason = gateway_id
            gateway_id = "gateway-1"
            gateway_name = "网关 1"
        assert gateway_name is not None
        with self.connect() as db:
            key = f"source_failed:{gateway_id}"
            if self.get_meta(db, key) != "1":
                self.queue(db, f"🔴 LiteLLM {gateway_name} 健康检查失败 | {now_text()}\n原因：{reason}")
            self.set_meta(db, key, "1")

    def next_message(self) -> tuple[int, str] | None:
        with self.connect() as db:
            rows = db.execute(
                "SELECT id, content FROM outbox WHERE sent_at IS NULL ORDER BY id"
            ).fetchall()
            for message_id, content in rows:
                db.executemany(
                    "INSERT OR IGNORE INTO outbox_delivery(outbox_id, webhook_index) VALUES (?, ?)",
                    [(message_id, index) for index in range(self.webhook_count)],
                )
                pending = db.execute(
                    "SELECT 1 FROM outbox_delivery WHERE outbox_id = ? AND webhook_index < ? "
                    "AND sent_at IS NULL LIMIT 1",
                    (message_id, self.webhook_count),
                ).fetchone()
                if pending:
                    return message_id, content
                db.execute("UPDATE outbox SET sent_at = ? WHERE id = ?", (now_text(), message_id))
            return None

    def is_delivered(self, message_id: int, webhook_index: int) -> bool:
        with self.connect() as db:
            row = db.execute(
                "SELECT sent_at FROM outbox_delivery WHERE outbox_id = ? AND webhook_index = ?",
                (message_id, webhook_index),
            ).fetchone()
            return bool(row and row[0])

    def mark_delivered(self, message_id: int, webhook_index: int) -> None:
        with self.connect() as db:
            db.execute(
                "UPDATE outbox_delivery SET sent_at = ? WHERE outbox_id = ? AND webhook_index = ?",
                (now_text(), message_id, webhook_index),
            )

    def mark_sent(self, message_id: int) -> None:
        with self.connect() as db:
            db.execute("UPDATE outbox SET sent_at = ? WHERE id = ?", (now_text(), message_id))

    def summary(self) -> dict[str, Any]:
        with self.connect() as db:
            rows = db.execute("SELECT healthy, COUNT(*) FROM endpoint_state GROUP BY healthy").fetchall()
            gateways = db.execute(
                "SELECT gateway_id, SUM(healthy), SUM(NOT healthy) "
                "FROM endpoint_state GROUP BY gateway_id ORDER BY gateway_id"
            ).fetchall()
            counts = {bool(healthy): count for healthy, count in rows}
            pending = db.execute("SELECT COUNT(*) FROM outbox WHERE sent_at IS NULL").fetchone()[0]
            source_failed = db.execute(
                "SELECT 1 FROM metadata WHERE "
                "((key LIKE 'source_failed:%') OR key = 'source_failed') AND value = '1' LIMIT 1"
            ).fetchone()
            initialized = db.execute(
                "SELECT 1 FROM metadata WHERE (key = 'initialized' AND value = '1') "
                "OR (key LIKE 'initialized:%' AND value = '1') LIMIT 1"
            ).fetchone()
            last_success = db.execute(
                "SELECT MAX(value) FROM metadata WHERE key = 'last_success_at' OR key LIKE 'last_success_at:%'"
            ).fetchone()[0]
            return {
                "initialized": bool(initialized),
                "source_failed": bool(source_failed),
                "last_success_at": last_success or None,
                "healthy_count": counts.get(True, 0),
                "unhealthy_count": counts.get(False, 0),
                "pending_notifications": pending,
                "gateway_count": len(gateways),
                "gateways": [
                    {"gateway_id": gateway_id, "healthy_count": healthy or 0, "unhealthy_count": unhealthy or 0}
                    for gateway_id, healthy, unhealthy in gateways
                ],
            }


def safe_failure(exc: Exception) -> str:
    if isinstance(exc, httpx.TimeoutException):
        return "LiteLLM 请求超时"
    if isinstance(exc, httpx.HTTPStatusError):
        return f"LiteLLM 返回 HTTP {exc.response.status_code}"
    if isinstance(exc, httpx.RequestError):
        return "无法连接 LiteLLM"
    if isinstance(exc, (ValueError, TypeError)):
        return "LiteLLM 响应格式无效"
    return "健康检查发生内部错误"


class HealthWatcher:
    def __init__(self, settings: Settings, store: StateStore):
        self.settings = settings
        self.store = store
        self.client = httpx.AsyncClient()
        self.stop = asyncio.Event()

    async def poll_once(self) -> None:
        await asyncio.gather(*(self.poll_gateway(gateway) for gateway in self.settings.gateways))

    async def poll_gateway(self, gateway: Gateway) -> None:
        try:
            response = await self.client.get(
                f"{gateway.base_url}/health",
                headers={"Authorization": f"Bearer {gateway.api_key}"},
                timeout=self.settings.health_timeout,
            )
            response.raise_for_status()
            current = parse_health_response(response.json())
            changes = self.store.record_success(gateway.gateway_id, gateway.name, current)
            LOG.info(
                "Health check complete for %s: %d deployments, %d change lines",
                gateway.name,
                len(current),
                len(changes),
            )
        except (httpx.HTTPError, ValueError, TypeError) as exc:
            reason = safe_failure(exc)
            LOG.warning("Health check failed for %s: %s", gateway.name, reason)
            self.store.record_failure(gateway.gateway_id, gateway.name, reason)

    async def send_pending(self) -> None:
        while message := self.store.next_message():
            message_id, content = message
            for webhook_index, webhook_url in enumerate(self.settings.webhook_urls):
                if self.store.is_delivered(message_id, webhook_index):
                    continue
                try:
                    response = await self.client.post(
                        webhook_url,
                        json={"msgtype": "text", "text": {"content": content}},
                        timeout=self.settings.webhook_timeout,
                    )
                    response.raise_for_status()
                    result = response.json()
                    if not isinstance(result, dict) or result.get("errcode") != 0:
                        raise ValueError("WeCom rejected the message")
                except (httpx.HTTPError, ValueError) as exc:
                    LOG.warning(
                        "WeCom notification failed for webhook %d: %s",
                        webhook_index + 1,
                        type(exc).__name__,
                    )
                    return
                self.store.mark_delivered(message_id, webhook_index)
                LOG.info(
                    "WeCom notification sent: outbox id %d, webhook %d",
                    message_id,
                    webhook_index + 1,
                )
            self.store.mark_sent(message_id)

    async def check_loop(self) -> None:
        while not self.stop.is_set():
            try:
                await self.poll_once()
            except Exception:
                LOG.exception("Health check loop error")
            try:
                await asyncio.wait_for(self.stop.wait(), timeout=self.settings.check_interval)
            except asyncio.TimeoutError:
                pass

    async def delivery_loop(self) -> None:
        while not self.stop.is_set():
            try:
                await self.send_pending()
            except Exception:
                LOG.exception("Notification loop error")
            try:
                await asyncio.wait_for(self.stop.wait(), timeout=30)
            except asyncio.TimeoutError:
                pass


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = Settings.from_env()
    store = StateStore(settings.database_path, len(settings.webhook_urls))
    watcher = HealthWatcher(settings, store)
    app.state.store = store
    tasks = [asyncio.create_task(watcher.check_loop()), asyncio.create_task(watcher.delivery_loop())]
    try:
        yield
    finally:
        watcher.stop.set()
        await asyncio.gather(*tasks, return_exceptions=True)
        await watcher.client.aclose()


app = FastAPI(title="LiteLLM Health Watcher", lifespan=lifespan)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/status")
def status() -> dict[str, Any]:
    return app.state.store.summary()
