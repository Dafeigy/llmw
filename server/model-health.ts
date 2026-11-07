import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { Express, Request, Response } from 'express'
import express from 'express'
import { getModelTagData, loadHealthSnapshot, saveHealthSnapshot } from './persistence.js'

type CheckStatus = 'healthy' | 'degraded' | 'unhealthy'
type DeploymentCheck = {
  id: string
  model: string
  deploymentId: string
  status: 'healthy' | 'unhealthy'
  checkedAt: string
  responseMs: number
  error?: string
}
type HealthEvent = {
  id: string
  model: string
  from: CheckStatus
  to: CheckStatus
  kind: 'abnormal' | 'recovered'
  occurredAt: string
  summary: string
  notified: boolean
  notificationError?: string
}
type HealthConfig = { intervalMinutes: number; watchedModels: string[]; webhookUrl: string }
type Store = { config: HealthConfig; checks: DeploymentCheck[]; events: HealthEvent[]; statuses: Record<string, CheckStatus> }
type Deployment = { model: string; id: string; litellmParams: Record<string, unknown>; modelInfo: Record<string, unknown>; mode?: string }
type AnyRecord = Record<string, any>

const base = (process.env.LITELLM_API_BASE ?? '').replace(/\/+$/, '')
const apiKey = process.env.LITELLM_API_KEY ?? ''
const dataFile = resolve(process.env.MODEL_HEALTH_DATA_FILE || 'data/model-health.json')
const intervalDefault = Number(process.env.MODEL_HEALTH_INTERVAL_MINUTES ?? 15)
const includePatterns = (process.env.MODEL_HEALTH_INCLUDE_MODELS ?? '').split(',').map((item) => item.trim()).filter(Boolean)
const excludePatterns = (process.env.MODEL_HEALTH_EXCLUDE_MODELS ?? '').split(',').map((item) => item.trim()).filter(Boolean)
const configuredTimeout = Number(process.env.MODEL_HEALTH_TIMEOUT_MS ?? 30_000)
const configuredConcurrency = Number(process.env.MODEL_HEALTH_CONCURRENCY ?? 4)
const timeoutMs = Number.isFinite(configuredTimeout) ? Math.min(120_000, Math.max(2_000, configuredTimeout)) : 30_000
const concurrency = Number.isFinite(configuredConcurrency) ? Math.min(16, Math.max(1, Math.round(configuredConcurrency))) : 4
const MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000

function validInterval(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(1440, Math.max(1, Math.round(number))) : 15
}

const defaultStore: Store = {
  config: { intervalMinutes: validInterval(intervalDefault), watchedModels: [], webhookUrl: process.env.WEWORK_WEBHOOK_URL ?? '' },
  checks: [],
  events: [],
  statuses: {},
}
let store: Store = structuredClone(defaultStore)
let storeReady = false
let running = false
let lastRunAt: string | null = null
let lastRunError: string | null = null
let scheduler: ReturnType<typeof setTimeout> | undefined

function records(payload: any): AnyRecord[] {
  if (Array.isArray(payload)) return payload
  for (const key of ['data', 'results', 'model_list', 'models', 'items']) {
    if (Array.isArray(payload?.[key])) return payload[key]
  }
  return []
}

function sanitizeError(value: unknown): string {
  return String(value instanceof Error ? value.message : value ?? '上游检查失败')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted-key]')
    .replace(/(api[_-]?key|token|secret)(\s*[=:]\s*)[^\s,;"']+/gi, '$1$2[redacted]')
    .replace(/([?&]key=)[^&#\s"'<>]+/gi, '$1[redacted]')
    .slice(0, 400)
}

function validWebhookUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'qyapi.weixin.qq.com' && url.pathname.endsWith('/cgi-bin/webhook/send') && url.searchParams.has('key')
  } catch {
    return false
  }
}

async function saveStore() {
  if (await saveHealthSnapshot(store)) return
  await mkdir(dirname(dataFile), { recursive: true })
  const tempFile = `${dataFile}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(tempFile, JSON.stringify(store), 'utf8')
  await rename(tempFile, dataFile)
}

async function ensureStore() {
  if (storeReady) return
  const persisted = await loadHealthSnapshot()
  try {
    const parsed = (persisted ?? JSON.parse(await readFile(dataFile, 'utf8'))) as Partial<Store>
    store = {
      config: {
        ...defaultStore.config,
        ...(parsed.config ?? {}),
        intervalMinutes: validInterval(parsed.config?.intervalMinutes ?? defaultStore.config.intervalMinutes),
        watchedModels: Array.isArray(parsed.config?.watchedModels) ? parsed.config!.watchedModels! : [],
        webhookUrl: typeof parsed.config?.webhookUrl === 'string' ? parsed.config.webhookUrl : defaultStore.config.webhookUrl,
      },
      checks: Array.isArray(parsed.checks) ? parsed.checks : [],
      events: Array.isArray(parsed.events) ? parsed.events : [],
      statuses: parsed.statuses && typeof parsed.statuses === 'object'
        ? Object.fromEntries(Object.entries(parsed.statuses).filter((entry): entry is [string, CheckStatus] => ['healthy', 'degraded', 'unhealthy'].includes(entry[1] as string)))
        : latestStatuses(Array.isArray(parsed.checks) ? parsed.checks : []),
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('Unable to read model health store:', sanitizeError(error))
  }
  storeReady = true
  // Import any existing file-based state into PostgreSQL on first startup.
  if (persisted === null) await saveHealthSnapshot(store)
}

async function liteRequest(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${apiKey}`)
  headers.set('Accept', 'application/json')
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  })
  const raw = await response.text()
  let payload: any = null
  try { payload = raw ? JSON.parse(raw) : null } catch { payload = raw }
  if (!response.ok) {
    const detail = typeof payload === 'string' ? payload : JSON.stringify(payload)
    throw new Error(`LiteLLM ${path} 返回 ${response.status}${detail ? `：${detail.slice(0, 220)}` : ''}`)
  }
  return payload
}

function matchesPattern(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i').test(value)
}

function isIncluded(deployment: Deployment): boolean {
  const candidates = [deployment.model, deployment.id]
  if (includePatterns.length && !includePatterns.some((pattern) => candidates.some((value) => matchesPattern(pattern, value)))) return false
  if (excludePatterns.some((pattern) => candidates.some((value) => matchesPattern(pattern, value)))) return false
  return true
}

export async function discoverDeployments(): Promise<Deployment[]> {
  const payload = await liteRequest('/model/info')
  const unique = new Map<string, Deployment>()
  for (const row of records(payload)) {
    const params = row.litellm_params && typeof row.litellm_params === 'object' ? row.litellm_params as AnyRecord : {}
    const info = row.model_info && typeof row.model_info === 'object' ? row.model_info as AnyRecord : {}
    const model = String(row.model_name ?? row.model_group ?? info.model_name ?? params.model ?? row.model ?? '').trim()
    const id = String(info.id ?? row.id ?? `${model}-${unique.size}`).trim()
    if (!model) continue
    unique.set(id, { model, id, litellmParams: params, modelInfo: info, mode: typeof row.mode === 'string' ? row.mode : undefined })
  }
  return [...unique.values()]
}

async function configuredDeployments(): Promise<Deployment[]> {
  return (await discoverDeployments()).filter(isIncluded)
}

async function checkDeployment(deployment: Deployment, checkedAt: string): Promise<DeploymentCheck> {
  const startedAt = Date.now()
  try {
    const payload = await liteRequest('/health/test_connection', {
      method: 'POST',
      body: JSON.stringify({
        ...(deployment.mode ? { mode: deployment.mode } : {}),
        litellm_params: deployment.litellmParams,
        model_info: deployment.modelInfo,
      }),
    })
    const failed = payload?.healthy === false || payload?.success === false || payload?.status === 'unhealthy' || payload?.status === 'error' || Boolean(payload?.error)
    return {
      id: randomUUID(), model: deployment.model, deploymentId: deployment.id,
      status: failed ? 'unhealthy' : 'healthy', checkedAt, responseMs: Date.now() - startedAt,
      ...(failed ? { error: sanitizeError(payload?.error ?? payload?.message ?? '健康检查失败') } : {}),
    }
  } catch (error) {
    return {
      id: randomUUID(), model: deployment.model, deploymentId: deployment.id,
      status: 'unhealthy', checkedAt, responseMs: Date.now() - startedAt, error: sanitizeError(error),
    }
  }
}

async function mapConcurrent<T, R>(values: T[], limit: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++
      results[index] = await mapper(values[index]!)
    }
  }))
  return results
}

function summarize(checks: DeploymentCheck[]): Map<string, CheckStatus> {
  const grouped = new Map<string, DeploymentCheck[]>()
  for (const check of checks) grouped.set(check.model, [...(grouped.get(check.model) ?? []), check])
  const result = new Map<string, CheckStatus>()
  for (const [model, group] of grouped) {
    const healthy = group.filter((check) => check.status === 'healthy').length
    result.set(model, healthy === group.length ? 'healthy' : healthy > 0 ? 'degraded' : 'unhealthy')
  }
  return result
}

function latestStatuses(checks: DeploymentCheck[]): Record<string, CheckStatus> {
  const latest = new Map<string, DeploymentCheck[]>()
  const timestamps = new Map<string, string>()
  for (const check of checks) {
    const current = timestamps.get(check.model)
    if (!current || check.checkedAt > current) timestamps.set(check.model, check.checkedAt)
  }
  for (const check of checks) {
    if (timestamps.get(check.model) === check.checkedAt) latest.set(check.model, [...(latest.get(check.model) ?? []), check])
  }
  return Object.fromEntries(summarize([...latest.values()].flat()))
}

function previousStatuses(): Map<string, CheckStatus> {
  return new Map(Object.entries(store.statuses))
}

async function sendWecom(event: HealthEvent) {
  const webhook = store.config.webhookUrl
  if (!webhook) return { notified: false as const }
  const statusName = (status: CheckStatus) => status === 'healthy' ? '可用' : status === 'degraded' ? '部分异常' : '不可用'
  const title = event.kind === 'recovered' ? '模型健康已恢复' : '模型健康异常'
  const content = [
    `### ${title}`,
    `> 模型：${event.model}`,
    `> 当前状态：${statusName(event.to)}`,
    `> 检查时间：${new Date(event.occurredAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`,
    `> 详情：${event.summary}`,
  ].join('\n')
  try {
    const response = await fetch(webhook, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { content } }),
      signal: AbortSignal.timeout(10_000),
    })
    const raw = await response.text()
    let result: AnyRecord = {}
    try {
      result = raw ? JSON.parse(raw) as AnyRecord : {}
    } catch {
      // Proxies and gateways often return an HTML or plain-text error page.
    }
    if (!response.ok || (typeof result.errcode === 'number' && result.errcode !== 0)) {
      const bodyDetail = typeof result.errmsg === 'string'
        ? result.errmsg
        : raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300)
      const statusText = response.statusText ? ` ${response.statusText}` : ''
      throw new Error(sanitizeError(`企业微信返回 ${response.status}${statusText}${bodyDetail ? `：${bodyDetail}` : ''}`))
    }
    return { notified: true as const }
  } catch (error) {
    return { notified: false as const, notificationError: sanitizeError(error) }
  }
}

async function runHealthCheck() {
  if (running) return
  running = true
  await ensureStore()
  const checkedAt = new Date().toISOString()
  const before = previousStatuses()
  try {
    if (!base || !apiKey) throw new Error('请先配置 LITELLM_API_BASE 和 LITELLM_API_KEY。')
    const deployments = await configuredDeployments()
    const currentChecks = await mapConcurrent(deployments, concurrency, (deployment) => checkDeployment(deployment, checkedAt))
    const after = summarize(currentChecks)
    store.checks.push(...currentChecks)
    store.checks = store.checks.filter((check) => Date.now() - Date.parse(check.checkedAt) < MAX_AGE_MS)
    store.statuses = { ...store.statuses, ...Object.fromEntries(after) }

    const newEvents: HealthEvent[] = []
    for (const [model, to] of after) {
      const from = before.get(model)
      if (from === undefined || from === to) continue
      // Treat degraded and unhealthy as the same alert state. Notify only when
      // a previously observed model crosses between healthy and abnormal.
      const isRecovery = from !== 'healthy' && to === 'healthy'
      const isAbnormal = from === 'healthy' && to !== 'healthy'
      if (!isRecovery && !isAbnormal) continue
      if (store.config.watchedModels.length && !store.config.watchedModels.includes(model)) continue
      const modelChecks = currentChecks.filter((check) => check.model === model && check.status === 'unhealthy')
      const event: HealthEvent = {
        id: randomUUID(), model, from, to, kind: isRecovery ? 'recovered' : 'abnormal', occurredAt: checkedAt,
        summary: isRecovery ? '所有部署均已恢复。' : modelChecks.map((check) => `${check.deploymentId}: ${check.error ?? '检查失败'}`).join('；').slice(0, 600),
        notified: false,
      }
      newEvents.push(event)
    }
    store.events.push(...newEvents)
    // Persist the new comparison baseline and events before sending so a
    // restart can resume delivery without diffing the same transition again.
    await saveStore()
    for (const event of store.events.filter((candidate) => !candidate.notified)) {
      const notification = await sendWecom(event)
      event.notified = notification.notified
      if (notification.notificationError) event.notificationError = notification.notificationError
      else if (notification.notified) delete event.notificationError
    }
    lastRunAt = checkedAt
    lastRunError = null
  } catch (error) {
    lastRunError = sanitizeError(error)
  } finally {
    running = false
    store.events = store.events.slice(-2000)
    await saveStore()
  }
}

function scheduleNext() {
  if (scheduler) clearTimeout(scheduler)
  scheduler = setTimeout(async () => {
    await runHealthCheck()
    scheduleNext()
  }, store.config.intervalMinutes * 60_000)
  scheduler.unref?.()
}

function queryDate(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const date = Date.parse(`${value}T00:00:00.000Z`)
  return Number.isFinite(date) ? date : null
}

function settingsResponse() {
  return {
    intervalMinutes: store.config.intervalMinutes,
    watchedModels: store.config.watchedModels,
    watchAllModels: store.config.watchedModels.length === 0,
    webhookConfigured: Boolean(store.config.webhookUrl),
    includePatterns,
    excludePatterns,
    concurrency,
    timeoutMs,
    running,
    lastRunAt,
    lastRunError,
  }
}

export function registerModelHealth(app: Express) {
  const router = express.Router()

  router.get('/config', async (_req, res) => {
    await ensureStore()
    let models: string[] = []
    let modelsError: string | undefined
    try { models = [...new Set((await configuredDeployments()).map((deployment) => deployment.model))].sort() }
    catch (error) { modelsError = sanitizeError(error) }
    res.json({ ...settingsResponse(), models, modelsError })
  })

  router.put('/config', async (req: Request, res: Response) => {
    await ensureStore()
    const body = req.body as AnyRecord
    const interval = Number(body.intervalMinutes)
    if (!Number.isFinite(interval) || interval < 1 || interval > 1440) {
      res.status(400).json({ error: '检查间隔必须是 1 到 1440 分钟。' })
      return
    }
    if (body.watchedModels !== undefined && (!Array.isArray(body.watchedModels) || body.watchedModels.some((model: unknown) => typeof model !== 'string'))) {
      res.status(400).json({ error: '关注模型格式无效。' })
      return
    }
    if (body.webhookUrl !== undefined && typeof body.webhookUrl !== 'string') {
      res.status(400).json({ error: '企业微信 Webhook 地址格式无效。' })
      return
    }
    if (typeof body.webhookUrl === 'string' && body.webhookUrl.trim() && !validWebhookUrl(body.webhookUrl.trim())) {
      res.status(400).json({ error: '请输入企业微信机器人提供的 HTTPS Webhook 地址。' })
      return
    }
    store.config.intervalMinutes = validInterval(interval)
    const watchedModels = Array.isArray(body.watchedModels) ? body.watchedModels as string[] : store.config.watchedModels
    store.config.watchedModels = [...new Set(watchedModels.filter((model) => model.trim()))]
    if (body.clearWebhook === true) store.config.webhookUrl = ''
    else if (typeof body.webhookUrl === 'string' && body.webhookUrl.trim()) store.config.webhookUrl = body.webhookUrl.trim()
    await saveStore()
    scheduleNext()
    res.json(settingsResponse())
  })

  router.post('/config/test-webhook', async (_req, res) => {
    await ensureStore()
    if (!store.config.webhookUrl) {
      res.status(400).json({ error: '请先保存企业微信 Webhook 地址。' })
      return
    }
    const result = await sendWecom({ id: randomUUID(), model: '测试通知', from: 'healthy', to: 'healthy', kind: 'recovered', occurredAt: new Date().toISOString(), summary: '企业微信通知配置测试成功。', notified: false })
    if (!result.notified) {
      res.status(502).json({ error: result.notificationError ?? '发送测试通知失败。' })
      return
    }
    res.json({ ok: true })
  })

  router.get('/history', async (req, res) => {
    await ensureStore()
    const days = Math.min(180, Math.max(1, Number(req.query.days ?? 30) || 30))
    const start = typeof req.query.start === 'string' ? queryDate(req.query.start) : null
    const end = typeof req.query.end === 'string' ? queryDate(req.query.end) : null
    const from = start ?? Date.now() - days * 24 * 60 * 60 * 1000
    const to = end === null ? Date.now() : end + 24 * 60 * 60 * 1000
    const model = typeof req.query.model === 'string' ? req.query.model : ''
    res.json({
      checks: store.checks.filter((check) => Date.parse(check.checkedAt) >= from && Date.parse(check.checkedAt) < to && (!model || check.model === model)),
      events: store.events.filter((event) => Date.parse(event.occurredAt) >= from && Date.parse(event.occurredAt) < to && (!model || event.model === model)),
      from: new Date(from).toISOString(), to: new Date(to).toISOString(),
    })
  })

  router.get('/status', async (_req, res) => {
    await ensureStore()
    let activeModels: Set<string> | null = null
    try { activeModels = new Set((await configuredDeployments()).map((deployment) => deployment.model)) }
    catch { /* Keep the last known status visible while LiteLLM model discovery is unavailable. */ }
    let tagData: { assignments: Record<string, string[]>; catalog: string[] } = { assignments: {}, catalog: [] }
    try { tagData = await getModelTagData() } catch { /* Tags are optional when PostgreSQL is not configured. */ }
    const latestTimestamp = new Map<string, string>()
    for (const check of store.checks) {
      if (!latestTimestamp.has(check.model) || latestTimestamp.get(check.model)! < check.checkedAt) latestTimestamp.set(check.model, check.checkedAt)
    }
    const latest = store.checks.filter((check) => latestTimestamp.get(check.model) === check.checkedAt && (!activeModels || activeModels.has(check.model)))
    const groups = new Map<string, DeploymentCheck[]>()
    for (const check of latest) groups.set(check.model, [...(groups.get(check.model) ?? []), check])
    const models = [...groups].map(([model, checks]) => {
      const healthy = checks.filter((check) => check.status === 'healthy').length
      const status: CheckStatus = healthy === checks.length ? 'healthy' : healthy > 0 ? 'degraded' : 'unhealthy'
      const responseMs = checks.map((check) => check.responseMs)
      return { model, tags: tagData.assignments[model] ?? [], status, healthyDeployments: healthy, deploymentCount: checks.length, responseMs: responseMs.length ? Math.round(responseMs.reduce((sum, value) => sum + value, 0) / responseMs.length) : null, checkedAt: checks[0]!.checkedAt, deployments: checks }
    }).sort((a, b) => a.model.localeCompare(b.model))
    const counts = { healthy: models.filter((model) => model.status === 'healthy').length, degraded: models.filter((model) => model.status === 'degraded').length, unhealthy: models.filter((model) => model.status === 'unhealthy').length }
    res.json({ models, tags: tagData.catalog, counts, checkedAt: latest.reduce((date, check) => !date || date < check.checkedAt ? check.checkedAt : date, ''), running, lastRunError })
  })

  router.post('/check', async (_req, res) => {
    await ensureStore()
    if (running) {
      res.status(409).json({ error: '健康检查正在运行。' })
      return
    }
    await runHealthCheck()
    res.status(lastRunError ? 502 : 200).json({ ok: !lastRunError, lastRunAt, lastRunError })
  })

  app.use('/api/model-health', router)
  void ensureStore().then(async () => {
    scheduleNext()
    const latestCheck = store.checks.reduce<string | null>((latest, check) => !latest || latest < check.checkedAt ? check.checkedAt : latest, null)
    if (!latestCheck || Date.now() - Date.parse(latestCheck) >= store.config.intervalMinutes * 60_000) await runHealthCheck()
  })
}
