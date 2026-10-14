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


@dataclass(frozen=True)
class Settings:
    base_url: str
    api_key: str
    webhook_url: str
    database_path: Path
    check_interval: float
    health_timeout: float
    webhook_timeout: float

    @classmethod
    def from_env(cls) -> Settings:
        required = ("LITELLM_BASE_URL", "LITELLM_API_KEY", "WEBHOOK_URL")
        missing = [name for name in required if not os.getenv(name)]
        if missing:
            raise ValueError(f"Missing environment variables: {', '.join(missing)}")
        return cls(
            base_url=os.environ["LITELLM_BASE_URL"].rstrip("/"),
            api_key=os.environ["LITELLM_API_KEY"],
            webhook_url=os.environ["WEBHOOK_URL"],
            database_path=Path(os.getenv("SQLITE_PATH", "data/health.sqlite3")),
            check_interval=positive_number("CHECK_INTERVAL_SECONDS", "900"),
            health_timeout=positive_number("LITELLM_TIMEOUT_SECONDS", "120"),
            webhook_timeout=positive_number("WEBHOOK_TIMEOUT_SECONDS", "10"),
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


def message_chunks(lines: list[str], current: dict[str, Endpoint]) -> list[str]:
    if not lines:
        return []
    healthy = sum(endpoint.healthy for endpoint in current.values())
    footer = f"当前：正常 {healthy} / 异常 {len(current) - healthy}"
    header = f"LiteLLM 模型健康变化 | {now_text()}"
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
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS endpoint_state (
                    model_id TEXT PRIMARY KEY, model TEXT NOT NULL,
                    provider TEXT NOT NULL, credential TEXT NOT NULL,
                    healthy INTEGER NOT NULL, error_type TEXT NOT NULL,
                    http_status INTEGER
                );
                CREATE TABLE IF NOT EXISTS metadata (
                    key TEXT PRIMARY KEY, value TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS outbox (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    content TEXT NOT NULL, created_at TEXT NOT NULL,
                    sent_at TEXT
                );
                """
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

    @staticmethod
    def queue(db: sqlite3.Connection, content: str) -> None:
        db.execute(
            "INSERT INTO outbox(content, created_at) VALUES (?, ?)",
            (content, now_text()),
        )

    @staticmethod
    def load(db: sqlite3.Connection) -> dict[str, Endpoint]:
        rows = db.execute(
            "SELECT model_id, model, provider, credential, healthy, error_type, http_status "
            "FROM endpoint_state"
        ).fetchall()
        return {
            row[0]: Endpoint(row[0], row[1], row[2], row[3], bool(row[4]), row[5], row[6])
            for row in rows
        }

    def record_success(self, current: dict[str, Endpoint]) -> list[str]:
        with self.connect() as db:
            previous = self.load(db)
            initialized = self.get_meta(db, "initialized") == "1"
            source_failed = self.get_meta(db, "source_failed") == "1"
            if initialized and previous and not current:
                raise ValueError("empty health result would remove every deployment")
            lines = change_lines(previous, current) if initialized else []
            if source_failed:
                lines.insert(0, "🟢 LiteLLM 健康检查接口已恢复")
            db.execute("DELETE FROM endpoint_state")
            db.executemany(
                "INSERT INTO endpoint_state VALUES (?, ?, ?, ?, ?, ?, ?)",
                [
                    (e.model_id, e.model, e.provider, e.credential,
                     int(e.healthy), e.error_type, e.http_status)
                    for e in current.values()
                ],
            )
            self.set_meta(db, "initialized", "1")
            self.set_meta(db, "source_failed", "0")
            self.set_meta(db, "last_success_at", now_text())
            for content in message_chunks(lines, current):
                self.queue(db, content)
            return lines

    def record_failure(self, reason: str) -> None:
        with self.connect() as db:
            if self.get_meta(db, "source_failed") != "1":
                self.queue(db, f"🔴 LiteLLM 健康检查失败 | {now_text()}\n原因：{reason}")
            self.set_meta(db, "source_failed", "1")

    def next_message(self) -> tuple[int, str] | None:
        with self.connect() as db:
            return db.execute(
                "SELECT id, content FROM outbox WHERE sent_at IS NULL ORDER BY id LIMIT 1"
            ).fetchone()

    def mark_sent(self, message_id: int) -> None:
        with self.connect() as db:
            db.execute("UPDATE outbox SET sent_at = ? WHERE id = ?", (now_text(), message_id))

    def summary(self) -> dict[str, Any]:
        with self.connect() as db:
            rows = db.execute(
                "SELECT healthy, COUNT(*) FROM endpoint_state GROUP BY healthy"
            ).fetchall()
            counts = {bool(healthy): count for healthy, count in rows}
            pending = db.execute("SELECT COUNT(*) FROM outbox WHERE sent_at IS NULL").fetchone()[0]
            return {
                "initialized": self.get_meta(db, "initialized") == "1",
                "source_failed": self.get_meta(db, "source_failed") == "1",
                "last_success_at": self.get_meta(db, "last_success_at") or None,
                "healthy_count": counts.get(True, 0),
                "unhealthy_count": counts.get(False, 0),
                "pending_notifications": pending,
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
        try:
            response = await self.client.get(
                f"{self.settings.base_url}/health",
                headers={"Authorization": f"Bearer {self.settings.api_key}"},
                timeout=self.settings.health_timeout,
            )
            response.raise_for_status()
            current = parse_health_response(response.json())
            changes = self.store.record_success(current)
            LOG.info("Health check complete: %d deployments, %d change lines", len(current), len(changes))
        except (httpx.HTTPError, ValueError, TypeError) as exc:
            reason = safe_failure(exc)
            LOG.warning("Health check failed: %s", reason)
            self.store.record_failure(reason)

    async def send_pending(self) -> None:
        while message := self.store.next_message():
            message_id, content = message
            try:
                response = await self.client.post(
                    self.settings.webhook_url,
                    json={"msgtype": "text", "text": {"content": content}},
                    timeout=self.settings.webhook_timeout,
                )
                response.raise_for_status()
                result = response.json()
                if not isinstance(result, dict) or result.get("errcode") != 0:
                    raise ValueError("WeCom rejected the message")
            except (httpx.HTTPError, ValueError) as exc:
                LOG.warning("WeCom notification failed: %s", type(exc).__name__)
                return
            self.store.mark_sent(message_id)
            LOG.info("WeCom notification sent: outbox id %d", message_id)

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
    store = StateStore(settings.database_path)
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
