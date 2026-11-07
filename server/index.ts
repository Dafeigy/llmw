import 'dotenv/config'
import express from 'express'
import { registerModelHealth } from './model-health.js'
import { registerModelManagement } from './model-management.js'
import { closePersistence, getCachedJson, initializePersistence, setCachedJson } from './persistence.js'

const app = express()
app.use(express.json({ limit: '256kb' }))
const port = Number(process.env.PORT ?? 3001)
const base = (process.env.LITELLM_API_BASE ?? '').replace(/\/+$/, '')
const apiKey = process.env.LITELLM_API_KEY ?? ''

type UsageDay = { date: string; tokens: number; requests: number; spend: number; promptTokens: number; completionTokens: number }
type AnyRecord = Record<string, any>

function records(payload: any): AnyRecord[] {
  if (Array.isArray(payload)) return payload
  for (const key of ['results', 'data', 'daily_activity', 'items', 'by_date']) {
    if (Array.isArray(payload?.[key])) return payload[key]
  }
  return []
}

function metric(row: AnyRecord, names: string[]): number {
  const sources = [row?.metrics, row?.metric, row?.summary, row]
  for (const source of sources) {
    for (const name of names) {
      const value = Number(source?.[name])
      if (Number.isFinite(value)) return value
    }
  }
  return 0
}

async function liteLLM(path: string, params: URLSearchParams) {
  const response = await fetch(`${base}${path}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`LiteLLM ${path} 返回 ${response.status}${detail ? `：${detail.slice(0, 180)}` : ''}`)
  }
  return response.json()
}

app.get('/api/health', (_req, res) => {
  res.json({ configured: Boolean(base && apiKey), baseUrl: base || null })
})

app.get('/api/usage', async (_req, res) => {
  if (!base || !apiKey) {
    res.status(503).json({ error: '请先在 .env 中配置 LITELLM_API_BASE 和 LITELLM_API_KEY。' })
    return
  }

  const cached = await getCachedJson<{ days: UsageDay[]; today: UsageDay; updatedAt: string; source: string; requestSource: string }>('usage:latest')
  if (cached) { res.json(cached); return }

  const formatDate = (date: Date) => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
  const endDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const end = new Date(`${endDate}T00:00:00.000Z`)
  const start = new Date(end)
  start.setUTCDate(end.getUTCDate() - 6)
  const startDate = formatDate(start)
  const params = new URLSearchParams({ start_date: startDate, end_date: endDate })

  try {
    // This daily rollup works on standard LiteLLM deployments. /global/spend/report
    // requires an Enterprise license, and /gateway/daily/activity is missing on
    // some versions. The aggregated activity response contains all three metrics.
    const activityPayload = await liteLLM('/user/daily/activity/aggregated', params)

    const days = new Map<string, UsageDay>()
    for (let cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
      const date = formatDate(cursor)
      days.set(date, { date, tokens: 0, requests: 0, spend: 0, promptTokens: 0, completionTokens: 0 })
    }

    for (const row of records(activityPayload)) {
      const date = String(row.date ?? row.group_by_day ?? row.day ?? '').slice(0, 10)
      const day = days.get(date)
      if (!day) continue
      day.tokens = metric(row, ['total_tokens', 'tokens'])
      day.spend = metric(row, ['spend', 'total_spend', 'total_cost'])
      day.requests = metric(row, ['api_requests', 'requests', 'total_requests', 'request_count', 'total_api_requests'])
      day.promptTokens = metric(row, ['prompt_tokens', 'input_tokens'])
      day.completionTokens = metric(row, ['completion_tokens', 'output_tokens'])
    }

    const result = [...days.values()]
    const current = result.at(-1)!
    const response = { days: result, today: current, updatedAt: new Date().toISOString(), source: 'litellm', requestSource: 'daily_activity_aggregated' }
    await setCachedJson('usage:latest', response, 60)
    res.json(response)
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'LiteLLM 请求失败' })
  }
})

app.get('/api/usage/trend', async (req, res) => {
  if (!base || !apiKey) {
    res.status(503).json({ error: '请先在 .env 中配置 LITELLM_API_BASE 和 LITELLM_API_KEY。' })
    return
  }

  const isDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  const now = new Date()
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
  const endDate = isDate(req.query.endDate) ? req.query.endDate : today
  const defaultStart = new Date(`${endDate}T00:00:00.000Z`)
  defaultStart.setUTCDate(defaultStart.getUTCDate() - 89)
  const startDate = isDate(req.query.startDate) ? req.query.startDate : `${defaultStart.getUTCFullYear()}-${String(defaultStart.getUTCMonth() + 1).padStart(2, '0')}-${String(defaultStart.getUTCDate()).padStart(2, '0')}`
  if (startDate > endDate) {
    res.status(400).json({ error: '开始日期不能晚于结束日期。' })
    return
  }
  const span = (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000
  if (span > 365) {
    res.status(400).json({ error: '日期范围最多支持 366 天。' })
    return
  }

  const selectedModel = typeof req.query.model === 'string' ? req.query.model : ''
  const cacheKey = `usage:trend:${startDate}:${endDate}:${selectedModel}`
  const cached = await getCachedJson<{ days: UsageDay[]; options: { model: string[] }; startDate: string; endDate: string }>(cacheKey)
  if (cached) { res.json(cached); return }
  const days = new Map<string, UsageDay>()
  for (let cursor = new Date(`${startDate}T00:00:00.000Z`); cursor <= new Date(`${endDate}T00:00:00.000Z`); cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const date = `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}-${String(cursor.getUTCDate()).padStart(2, '0')}`
    days.set(date, { date, tokens: 0, requests: 0, spend: 0, promptTokens: 0, completionTokens: 0 })
  }

  try {
    // Read daily rollups instead of paging through individual spend log entries.
    const params = new URLSearchParams({
      start_date: startDate,
      end_date: endDate,
    })
    if (selectedModel) params.set('model', selectedModel)
    const payload = await liteLLM('/user/daily/activity/aggregated', params)
    const models = new Set<string>()
    for (const row of records(payload)) {
      const date = String(row.date ?? row.group_by_day ?? row.day ?? '').slice(0, 10)
      const day = days.get(date)
      if (!day) continue

      const modelBreakdown = row.breakdown?.models && typeof row.breakdown.models === 'object'
        ? row.breakdown.models as Record<string, AnyRecord>
        : {}
      for (const model of Object.keys(modelBreakdown)) models.add(model)
      // LiteLLM applies the model filter upstream and may return filtered metrics
      // without a per-model breakdown. Prefer the matching breakdown when present.
      const selectedMetrics = selectedModel ? modelBreakdown[selectedModel]?.metrics : undefined
      const source = selectedModel ? selectedMetrics ?? row.metrics ?? row : row.metrics ?? row
      if (!source) continue

      const prompt = metric(source, ['prompt_tokens', 'input_tokens', 'total_prompt_tokens'])
      const completion = metric(source, ['completion_tokens', 'output_tokens', 'total_completion_tokens'])
      day.promptTokens += prompt
      day.completionTokens += completion
      day.tokens += metric(source, ['total_tokens', 'tokens']) || prompt + completion
      day.requests += metric(source, ['api_requests', 'requests', 'total_requests', 'request_count'])
      day.spend += metric(source, ['spend', 'total_spend', 'total_cost'])
    }

    const response = {
      days: [...days.values()],
      options: { model: [...models].sort((a, b) => a.localeCompare(b)) },
      startDate,
      endDate,
    }
    await setCachedJson(cacheKey, response, 300)
    res.json(response)
  } catch (error) {
    // LiteLLM's aggregate endpoint can raise this when the selected range has
    // no activity at all. Treat that specific empty-aggregate failure as a
    // valid zero-usage range so historical years remain viewable.
    const message = error instanceof Error ? error.message : ''
    if (message.includes("unsupported operand type(s) for +: 'NoneType' and 'NoneType'")) {
      res.json({
        days: [...days.values()],
        options: { model: [] },
        startDate,
        endDate,
      })
      return
    }
    res.status(502).json({ error: error instanceof Error ? error.message : '读取 LiteLLM 用量明细失败' })
  }
})

app.use(express.static('dist'))

async function start() {
  await initializePersistence()
  registerModelHealth(app)
  registerModelManagement(app)
  // Register the SPA fallback after API routes. Registering it before the
  // asynchronously initialized model-health router makes API requests return
  // index.html, which the client then fails to parse as JSON.
  app.get('/{*path}', (_req, res, next) => {
    res.sendFile('index.html', { root: 'dist' }, (error) => { if (error) next() })
  })
  const server = app.listen(port, () => console.log(`LiteLLM dashboard server listening on http://localhost:${port}`))
  const shutdown = () => server.close(() => { void closePersistence().finally(() => process.exit(0)) })
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

void start().catch((error) => {
  console.error('Unable to start server:', error)
  process.exitCode = 1
})
