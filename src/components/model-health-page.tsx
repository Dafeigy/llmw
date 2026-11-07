import * as React from 'react'
import {
  Activity, AlertCircle, BellRing, Check, CheckCircle2, ChevronDown, CircleAlert,
  CircleX, Clock3, LoaderCircle, RefreshCw, Save, Send, Settings2,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'

type Status = 'healthy' | 'degraded' | 'unhealthy'
type DeploymentCheck = { id: string; model: string; deploymentId: string; status: 'healthy' | 'unhealthy'; checkedAt: string; responseMs: number; error?: string }
type ModelStatus = { model: string; status: Status; healthyDeployments: number; deploymentCount: number; responseMs: number | null; checkedAt: string; deployments: DeploymentCheck[] }
type HealthConfig = {
  intervalMinutes: number; watchedModels: string[]; watchAllModels: boolean; webhookConfigured: boolean;
  includePatterns: string[]; excludePatterns: string[]; models: string[]; modelsError?: string;
  running: boolean; lastRunAt: string | null; lastRunError: string | null;
}
type HealthEvent = { id: string; model: string; from: Status; to: Status; kind: 'abnormal' | 'recovered'; occurredAt: string; summary: string; notified: boolean; notificationError?: string }
type HistoryResponse = { checks: DeploymentCheck[]; events: HealthEvent[] }

const statusLabels: Record<Status, string> = { healthy: '可用', degraded: '部分异常', unhealthy: '不可用' }
const statusStyles: Record<Status, string> = {
  healthy: 'bg-emerald-500 text-white',
  degraded: 'bg-[#d5a52a] text-[#241b00]',
  unhealthy: 'bg-orange-500 text-white',
}
const statusDots: Record<Status, string> = { healthy: 'bg-emerald-500', degraded: 'bg-[#d5a52a]', unhealthy: 'bg-orange-500' }

function formatTime(value: string | null | undefined) {
  if (!value) return '暂无记录'
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value))
}

function dayKey(date: Date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

function lastDays(count: number) {
  const days: string[] = []
  const current = new Date(`${dayKey(new Date())}T00:00:00.000Z`)
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = new Date(current)
    date.setUTCDate(current.getUTCDate() - offset)
    days.push(dayKey(date))
  }
  return days
}

function statusFromChecks(checks: DeploymentCheck[]): Status | null {
  if (!checks.length) return null
  const healthy = checks.filter((check) => check.status === 'healthy').length
  return healthy === checks.length ? 'healthy' : healthy > 0 ? 'degraded' : 'unhealthy'
}

function availabilityForChecks(checks: DeploymentCheck[]): number | null {
  const samples = new Map<string, DeploymentCheck[]>()
  for (const check of checks) samples.set(check.checkedAt, [...(samples.get(check.checkedAt) ?? []), check])
  const statuses = [...samples.values()].map(statusFromChecks).filter((value): value is Status => value !== null)
  return statuses.length ? statuses.filter((status) => status !== 'unhealthy').length / statuses.length * 100 : null
}

function DailyHistory({ checks, days }: { checks: DeploymentCheck[]; days: string[] }) {
  const groups = new Map<string, Map<string, DeploymentCheck[]>>()
  for (const check of checks) {
    const date = dayKey(new Date(check.checkedAt))
    const dateGroup = groups.get(date) ?? new Map<string, DeploymentCheck[]>()
    dateGroup.set(check.checkedAt, [...(dateGroup.get(check.checkedAt) ?? []), check])
    groups.set(date, dateGroup)
  }
  const summaries = new Map<string, { availability: number; status: Status | null; checks: number }>()
  for (const date of days) {
    const slots = [...(groups.get(date)?.values() ?? [])]
    const statuses = slots.map(statusFromChecks).filter((value): value is Status => value !== null)
    const availability = statuses.length ? Math.round(statuses.filter((status) => status !== 'unhealthy').length / statuses.length * 100) : 0
    const status: Status | null = !statuses.length ? null : availability === 100 ? (statuses.includes('degraded') ? 'degraded' : 'healthy') : availability > 0 ? 'degraded' : 'unhealthy'
    summaries.set(date, { availability, status, checks: statuses.length })
  }
  return (
    <div className="mt-3">
      <div className="mb-1.5 flex items-center justify-between text-xs text-muted-foreground">
        <span>{days[0]}</span><span>{days.at(-1)}</span>
      </div>
      <div className="flex h-7 gap-1" role="img" aria-label="按日模型可用性历史">
        {days.map((day) => {
          const summary = summaries.get(day)!
          const color = !summary.status ? 'bg-muted' : summary.status === 'healthy' ? 'bg-emerald-500' : summary.status === 'unhealthy' ? 'bg-orange-500' : 'bg-[#d5a52a]'
          const title = summary.checks ? `${day} · 可用率 ${summary.availability}% · ${summary.checks} 轮检查` : `${day} · 暂无检查记录`
          return <span key={day} title={title} className={`min-w-0 flex-1 rounded-sm ${color} ${summary.status === 'degraded' && summary.availability > 0 ? 'opacity-70' : ''}`} />
        })}
      </div>
    </div>
  )
}

export function ModelHealthPage() {
  const [status, setStatus] = React.useState<ModelStatus[]>([])
  const [history, setHistory] = React.useState<HistoryResponse>({ checks: [], events: [] })
  const [config, setConfig] = React.useState<HealthConfig | null>(null)
  const [intervalMinutes, setIntervalMinutes] = React.useState(15)
  const [watchedModels, setWatchedModels] = React.useState<string[]>([])
  const [watchAll, setWatchAll] = React.useState(true)
  const [webhookUrl, setWebhookUrl] = React.useState('')
  const [webhookConfigured, setWebhookConfigured] = React.useState(false)
  const [period, setPeriod] = React.useState(30)
  const [selectedModel, setSelectedModel] = React.useState('')
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [checking, setChecking] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [testingWebhook, setTestingWebhook] = React.useState(false)
  const [error, setError] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const settingsInitialized = React.useRef(false)

  const refresh = React.useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true)
    try {
      const [statusResponse, configResponse, historyResponse] = await Promise.all([
        fetch('/api/model-health/status', { cache: 'no-store' }),
        fetch('/api/model-health/config', { cache: 'no-store' }),
        fetch(`/api/model-health/history?days=${period}`, { cache: 'no-store' }),
      ])
      const [statusData, configData, historyData] = await Promise.all([statusResponse.json(), configResponse.json(), historyResponse.json()])
      if (!statusResponse.ok) throw new Error(statusData.error ?? '无法读取模型健康状态')
      if (!configResponse.ok) throw new Error(configData.error ?? '无法读取监控配置')
      if (!historyResponse.ok) throw new Error(historyData.error ?? '无法读取历史记录')
      setStatus(statusData.models ?? [])
      setConfig(configData)
      if (!settingsInitialized.current) {
        setIntervalMinutes(configData.intervalMinutes)
        setWatchedModels(configData.watchedModels ?? [])
        setWatchAll(configData.watchAllModels ?? true)
        settingsInitialized.current = true
      }
      setWebhookConfigured(configData.webhookConfigured)
      setHistory(historyData)
      setError(configData.modelsError ?? statusData.lastRunError ?? '')
      setSelectedModel((current) => current || statusData.models?.[0]?.model || '')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '读取模型健康状态失败')
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [period])

  React.useEffect(() => {
    void refresh(true)
    const timer = window.setInterval(() => void refresh(), 30_000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const runNow = async () => {
    setChecking(true)
    setNotice('')
    try {
      const response = await fetch('/api/model-health/check', { method: 'POST' })
      const result = await response.json()
      if (!response.ok) throw new Error(result.lastRunError ?? result.error ?? '健康检查失败')
      setNotice('本轮健康检查已完成。')
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '健康检查失败')
    } finally {
      setChecking(false)
    }
  }

  const saveSettings = async () => {
    setSaving(true)
    setNotice('')
    try {
      const response = await fetch('/api/model-health/config', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intervalMinutes, watchedModels: watchAll ? [] : watchedModels, webhookUrl }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? '保存监控设置失败')
      settingsInitialized.current = true
      setWebhookConfigured(result.webhookConfigured)
      setWebhookUrl('')
      setNotice('监控设置已保存。')
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存监控设置失败')
    } finally {
      setSaving(false)
    }
  }

  const testWebhook = async () => {
    setTestingWebhook(true)
    setNotice('')
    try {
      const response = await fetch('/api/model-health/config/test-webhook', { method: 'POST' })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? '测试通知发送失败')
      setNotice('测试通知已发送到企业微信。')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '测试通知发送失败')
    } finally {
      setTestingWebhook(false)
    }
  }

  const removeWebhook = async () => {
    setSaving(true)
    setNotice('')
    try {
      const response = await fetch('/api/model-health/config', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intervalMinutes, watchedModels: watchAll ? [] : watchedModels, clearWebhook: true }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? '移除企业微信通知失败')
      setWebhookConfigured(false)
      setWebhookUrl('')
      setNotice('企业微信通知已关闭。')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '移除企业微信通知失败')
    } finally {
      setSaving(false)
    }
  }

  const toggleWatch = (model: string, checked: boolean | 'indeterminate') => {
    setWatchedModels((current) => checked ? [...new Set([...current, model])] : current.filter((item) => item !== model))
  }
  const days = React.useMemo(() => lastDays(period), [period])
  const counts = {
    healthy: status.filter((model) => model.status === 'healthy').length,
    degraded: status.filter((model) => model.status === 'degraded').length,
    unhealthy: status.filter((model) => model.status === 'unhealthy').length,
  }
  const selected = status.find((model) => model.model === selectedModel)
  const selectedChecks = history.checks.filter((check) => check.model === selectedModel).sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))
  const selectedEvents = history.events.filter((event) => event.model === selectedModel).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
  const orderedModels = [...status].sort((a, b) => ({ unhealthy: 0, degraded: 1, healthy: 2 }[a.status] - { unhealthy: 0, degraded: 1, healthy: 2 }[b.status]) || a.model.localeCompare(b.model))
  const lastCheckedAt = status.reduce<string | null>((latest, model) => !latest || latest < model.checkedAt ? model.checkedAt : latest, null)

  return (
    <div className="mx-auto flex w-full max-w-[1680px] flex-1 flex-col gap-5 px-4 py-5 lg:px-6 lg:py-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground"><Activity className="size-4" /> 模型运行监控</div>
          <h2 className="text-2xl font-semibold tracking-tight">模型健康</h2>
          <p className="mt-1 text-sm text-muted-foreground">追踪接入模型的可用状态和检查历史</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => setSettingsOpen((open) => !open)} aria-expanded={settingsOpen}>
            <Settings2 className="size-4" />监控设置<ChevronDown className={`size-4 transition-transform ${settingsOpen ? 'rotate-180' : ''}`} />
          </Button>
          <Button onClick={() => void runNow()} disabled={checking || loading}>
            {checking ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            {checking ? '检查中…' : '立即检查'}
          </Button>
        </div>
      </div>

      {error && <div role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"><AlertCircle className="mt-0.5 size-4 shrink-0" /><span>{error}</span></div>}
      {notice && <div role="status" className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-300"><Check className="size-4" />{notice}</div>}

      {settingsOpen && (
        <Card>
          <CardHeader className="border-b">
            <CardTitle className="flex items-center gap-2"><Settings2 className="size-4" />监控与告警设置</CardTitle>
            <CardDescription>环境变量提供默认检查范围；页面中的模型选择只控制告警关注范围。</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6 pt-5 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
            <div className="space-y-5">
              <div className="max-w-xs space-y-2">
                <label htmlFor="health-interval" className="text-sm font-medium">检查间隔（分钟）</label>
                <Input id="health-interval" type="number" min={1} max={1440} value={intervalMinutes} onChange={(event) => setIntervalMinutes(Number(event.target.value))} />
                <p className="text-xs text-muted-foreground">默认 15 分钟，保存后立即应用于后续周期。</p>
              </div>
              <div className="space-y-2">
                <label htmlFor="wecom-webhook" className="text-sm font-medium">企业微信机器人 Webhook</label>
                <Input id="wecom-webhook" type="password" autoComplete="new-password" placeholder={webhookConfigured ? '已配置，留空保持不变' : 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?...'} value={webhookUrl} onChange={(event) => setWebhookUrl(event.target.value)} />
                <p className="text-xs text-muted-foreground">地址仅存储在服务端。留空会保留已保存的地址。</p>
                <Button variant="outline" size="sm" onClick={() => void testWebhook()} disabled={testingWebhook || !webhookConfigured}>
                  {testingWebhook ? <LoaderCircle className="size-4 animate-spin" /> : <Send className="size-4" />}
                  发送测试通知
                </Button>
                {webhookConfigured && <Button variant="ghost" size="sm" onClick={() => void removeWebhook()} disabled={saving}>关闭通知</Button>}
              </div>
            </div>
            <div className="space-y-3">
              <div>
                <p className="text-sm font-medium">告警关注模型</p>
                <p className="mt-1 text-xs text-muted-foreground">异常和恢复时推送；默认关注全部模型。环境排除规则不受此项影响。</p>
              </div>
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm hover:bg-muted/40">
                <Checkbox checked={watchAll} onCheckedChange={(checked) => setWatchAll(checked === true)} aria-label="关注全部模型" />
                <span><span className="font-medium">关注全部模型</span><span className="mt-0.5 block text-xs text-muted-foreground">新接入的模型也会自动加入告警。</span></span>
              </label>
              {!watchAll && (
                <div className="grid max-h-56 gap-1 overflow-y-auto rounded-lg border p-2 sm:grid-cols-2">
                  {config?.models.length ? config.models.map((model) => (
                    <label key={model} className="flex min-h-10 cursor-pointer items-center gap-3 rounded-md px-2 text-sm hover:bg-muted/50">
                      <Checkbox checked={watchedModels.includes(model)} onCheckedChange={(checked) => toggleWatch(model, checked)} aria-label={`关注 ${model}`} />
                      <span className="truncate" title={model}>{model}</span>
                    </label>
                  )) : <p className="p-2 text-sm text-muted-foreground">读取模型列表后可选择关注模型。</p>}
                </div>
              )}
              {Boolean(config?.includePatterns.length || config?.excludePatterns.length) && (
                <div className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
                  <p>实际检查范围由环境变量过滤：</p>
                  {Boolean(config?.includePatterns.length) && <p className="mt-1">仅纳入：{config?.includePatterns.join('、')}</p>}
                  {Boolean(config?.excludePatterns.length) && <p className="mt-1">已排除：{config?.excludePatterns.join('、')}</p>}
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t pt-4 xl:col-span-2">
              <Button onClick={() => void saveSettings()} disabled={saving || intervalMinutes < 1 || intervalMinutes > 1440}>
                {saving ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}保存设置
              </Button>
              <span className="text-xs text-muted-foreground">无关注模型时，系统会自动按“全部模型”处理。</span>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard label="监控模型" value={status.length} icon={<Activity className="size-4" />} detail={`${config?.excludePatterns.length ? '已按环境变量过滤' : '当前纳入检查范围'}`} />
        <SummaryCard label="可用" value={counts.healthy} icon={<CheckCircle2 className="size-4 text-emerald-600" />} detail="所有部署正常" />
        <SummaryCard label="部分异常" value={counts.degraded} icon={<CircleAlert className="size-4 text-[#a78318]" />} detail="至少一个部署正常" />
        <SummaryCard label="不可用" value={counts.unhealthy} icon={<CircleX className="size-4 text-orange-600" />} detail="所有部署均检查失败" />
      </div>

      <Card>
        <CardHeader className="gap-3 border-b sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle>服务状态</CardTitle>
            <CardDescription className="mt-1">最近检查：{formatTime(lastCheckedAt)}（Asia/Shanghai）</CardDescription>
          </div>
          <div className="flex items-center gap-1 rounded-lg border p-1" aria-label="历史范围">
            {[7, 30, 90].map((value) => <Button key={value} size="sm" variant={period === value ? 'secondary' : 'ghost'} className="h-8 px-3" onClick={() => setPeriod(value)}>{value} 天</Button>)}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />正在读取健康状态…</div> : !orderedModels.length ? (
            <div className="flex min-h-56 flex-col items-center justify-center gap-2 px-6 text-center">
              <Activity className="size-8 text-muted-foreground/50" />
              <p className="font-medium">暂无模型健康记录</p>
              <p className="max-w-md text-sm text-muted-foreground">请确认 LiteLLM 地址和密钥已配置，并允许读取 `/model/info` 与调用 `/health/test_connection`。</p>
              {config?.modelsError && <p className="max-w-xl text-xs text-destructive">{config.modelsError}</p>}
            </div>
          ) : (
            <div className="divide-y">
              {orderedModels.map((model) => {
                const modelChecks = history.checks.filter((check) => check.model === model.model)
                const availability = availabilityForChecks(modelChecks)
                const isSelected = selectedModel === model.model
                return (
                  <div key={model.model}>
                    <button type="button" onClick={() => setSelectedModel(isSelected ? '' : model.model)} aria-expanded={isSelected} className="w-full cursor-pointer px-4 py-4 text-left transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset lg:px-6">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex min-w-0 items-center gap-2.5">
                          <span className={`size-2.5 shrink-0 rounded-full ${statusDots[model.status]}`} />
                          <span className="truncate font-medium" title={model.model}>{model.model}</span>
                          <Badge variant="outline" className={statusStyles[model.status]}>{statusLabels[model.status]}</Badge>
                          <span className="hidden text-xs text-muted-foreground sm:inline">{model.healthyDeployments}/{model.deploymentCount} 部署可用</span>
                        </div>
                        <div className="flex items-center gap-4 pl-5 text-sm text-muted-foreground sm:pl-0">
                          <span className="font-medium text-foreground">{availability === null ? '—' : `${availability.toFixed(2)}%`}<span className="ml-1 font-normal text-muted-foreground">可用率</span></span>
                          <span title="Dashboard 发起的健康检查请求总耗时">{model.responseMs === null ? '—' : `检查 ${model.responseMs} ms`}</span>
                          <span className="min-w-28 text-right">{formatTime(model.checkedAt)}</span>
                          <ChevronDown className={`size-4 transition-transform ${isSelected ? 'rotate-180' : ''}`} />
                        </div>
                      </div>
                      <DailyHistory checks={modelChecks} days={days} />
                    </button>
                    {isSelected && (
                      <div className="grid gap-5 border-t bg-muted/20 px-4 py-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(260px,0.8fr)] lg:px-6">
                        <section>
                          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold"><Clock3 className="size-4" />最近检查记录</h3>
                          {!selectedChecks.length ? <p className="text-sm text-muted-foreground">当前范围内没有检查记录。</p> : <div className="max-h-72 overflow-auto rounded-lg border bg-card">
                            <div className="divide-y">
                              {selectedChecks.slice(0, 60).map((check) => (
                                <div key={check.id} className="grid gap-1.5 px-3 py-2.5 text-xs sm:grid-cols-[150px_1fr_auto] sm:items-center">
                                  <span className="text-muted-foreground">{formatTime(check.checkedAt)}</span>
                                  <span className="truncate" title={check.deploymentId}>{check.deploymentId}</span>
                                  <span className={`flex items-center gap-1.5 font-medium ${check.status === 'healthy' ? 'text-emerald-700 dark:text-emerald-400' : 'text-orange-700 dark:text-orange-400'}`}>
                                    <span className={`size-1.5 rounded-full ${statusDots[check.status]}`} />{check.status === 'healthy' ? '通过' : '失败'} · {check.responseMs} ms
                                  </span>
                                  {check.error && <span className="sm:col-span-3 break-words text-destructive">{check.error}</span>}
                                </div>
                              ))}
                            </div>
                          </div>}
                        </section>
                        <section>
                          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold"><BellRing className="size-4" />状态变化</h3>
                          {!selectedEvents.length ? <p className="text-sm text-muted-foreground">所选时间范围内没有状态变化。</p> : <div className="space-y-2">
                            {selectedEvents.slice(0, 12).map((event) => (
                              <div key={event.id} className="rounded-lg border bg-card p-3">
                                <div className="flex items-center justify-between gap-2">
                                  <Badge variant="outline" className={event.kind === 'recovered' ? statusStyles.healthy : statusStyles.unhealthy}>{event.kind === 'recovered' ? '已恢复' : '新异常'}</Badge>
                                  <time className="text-xs text-muted-foreground">{formatTime(event.occurredAt)}</time>
                                </div>
                                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{event.summary}</p>
                                <p className="mt-2 text-xs">企业微信：{event.notified ? '已发送' : event.notificationError ? `发送失败 · ${event.notificationError}` : '未配置'}</p>
                              </div>
                            ))}
                          </div>}
                        </section>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t bg-muted/20 px-4 py-3 text-xs text-muted-foreground lg:px-6">
            <div className="flex flex-wrap items-center gap-3"><span className="inline-flex items-center gap-1.5"><i className="size-2 rounded-full bg-emerald-500" />正常</span><span className="inline-flex items-center gap-1.5"><i className="size-2 rounded-full bg-[#d5a52a]" />部分异常</span><span className="inline-flex items-center gap-1.5"><i className="size-2 rounded-full bg-orange-500" />不可用</span><span className="inline-flex items-center gap-1.5"><i className="size-2 rounded-full bg-muted-foreground/30" />无记录</span></div>
            <span>每格代表一天的检查可用率</span>
          </div>
        </CardContent>
      </Card>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5"><Clock3 className="size-3.5" />采样间隔 {config?.intervalMinutes ?? 15} 分钟</span>
        <span className="inline-flex items-center gap-1.5"><Activity className="size-3.5" />本机历史保留 60 天</span>
        {config?.running && <span className="inline-flex items-center gap-1.5 text-primary"><LoaderCircle className="size-3.5 animate-spin" />正在执行检查</span>}
      </div>
      {selected && <span className="sr-only">当前选择模型 {selected.model}</span>}
    </div>
  )
}

function SummaryCard({ label, value, icon, detail }: { label: string; value: number; icon: React.ReactNode; detail: string }) {
  return <Card size="sm"><CardHeader className="flex-row items-center justify-between gap-2 pb-1"><CardDescription>{label}</CardDescription>{icon}</CardHeader><CardContent><div className="text-2xl font-semibold tabular-nums">{value}</div><p className="mt-1 text-xs text-muted-foreground">{detail}</p></CardContent></Card>
}
