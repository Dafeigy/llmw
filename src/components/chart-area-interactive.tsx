import * as React from "react"
import { Activity, CalendarDays, ChartNoAxesCombined, ChevronDown, Filter, LoaderCircle, RefreshCw } from "lucide-react"
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Tooltip as ShadTooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Button } from "@/components/ui/button"
import type { UsageDay } from "@/lib/usage"
import { formatCurrency, formatDate, formatNumber } from "@/lib/usage"

type View = "line" | "heatmap"
type TrendResponse = { days: UsageDay[]; options: { model: string[] }; error?: string }
type TrendCacheEntry = { expiresAt: number; result: TrendResponse }

const TREND_CACHE_PREFIX = "litellm-usage-trend:v1:"
const TREND_CACHE_TTL_MS = 60_000

function readTrendCache(key: string): { result: TrendResponse; fresh: boolean } | null {
  try {
    const raw = sessionStorage.getItem(`${TREND_CACHE_PREFIX}${key}`)
    if (!raw) return null
    const entry = JSON.parse(raw) as TrendCacheEntry
    if (!entry.result || !Array.isArray(entry.result.days)) return null
    return { result: entry.result, fresh: entry.expiresAt > Date.now() }
  } catch {
    return null
  }
}

function writeTrendCache(key: string, result: TrendResponse) {
  try {
    const entry: TrendCacheEntry = { result, expiresAt: Date.now() + TREND_CACHE_TTL_MS }
    sessionStorage.setItem(`${TREND_CACHE_PREFIX}${key}`, JSON.stringify(entry))
  } catch {
    // The chart still works when storage is unavailable or full.
  }
}

function dateInShanghai(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date)
}

function shiftDate(date: string, amount: number) {
  const value = new Date(`${date}T12:00:00`)
  value.setDate(value.getDate() + amount)
  return dateInShanghai(value)
}

function Heatmap({ data, year }: { data: UsageDay[]; year: number }) {
  const dataByDate = new Map(data.map((day) => [day.date, day]))
  const yearDays: UsageDay[] = []
  for (let cursor = new Date(Date.UTC(year, 0, 1)); cursor.getUTCFullYear() === year; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const date = `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}-${String(cursor.getUTCDate()).padStart(2, "0")}`
    yearDays.push(dataByDate.get(date) ?? { date, tokens: 0, requests: 0, spend: 0 })
  }
  const values = yearDays.map((day) => day.tokens)
  const positive = values.filter((value) => value > 0).sort((a, b) => a - b)
  const thresholds = [0.25, 0.5, 0.75].map((part) => positive[Math.floor((positive.length - 1) * part)] ?? 0)
  const firstDate = yearDays[0]?.date
  const leading = firstDate ? (new Date(`${firstDate}T12:00:00`).getDay() + 6) % 7 : 0
  const cells = [...Array.from({ length: leading }, () => null), ...yearDays]
  const weeks = Array.from({ length: Math.ceil(cells.length / 7) }, (_, week) => cells.slice(week * 7, week * 7 + 7))
  let previousMonth = -1
  const monthLabels = weeks.map((week, index) => {
    const day = week.find(Boolean)
    if (!day) return ""
    const month = new Date(`${day.date}T12:00:00`).getMonth()
    const label = index === 0 || month !== previousMonth ? new Date(`${day.date}T12:00:00`).toLocaleDateString("zh-CN", { month: "short" }) : ""
    previousMonth = month
    return label
  })
  const colors = ["bg-muted", "bg-emerald-200 dark:bg-emerald-950", "bg-emerald-300 dark:bg-emerald-800", "bg-emerald-500 dark:bg-emerald-600", "bg-emerald-700 dark:bg-emerald-400"]
  const level = (tokens: number) => tokens <= 0 ? 0 : tokens <= thresholds[0] ? 1 : tokens <= thresholds[1] ? 2 : tokens <= thresholds[2] ? 3 : 4

  return (
    <div className="overflow-x-auto pb-2">
      <div className="min-w-[650px] sm:min-w-[780px] xl:min-w-[980px] 2xl:min-w-[1100px]">
        <div className="mb-2 grid grid-cols-[34px_1fr] gap-2 text-xs text-muted-foreground">
          <span />
          <div className="grid grid-flow-col auto-cols-[12px] justify-center gap-1 sm:auto-cols-[14px] lg:auto-cols-[16px] 2xl:auto-cols-[20px]">
            {monthLabels.map((month, index) => <span key={index} className="whitespace-nowrap">{month}</span>)}
          </div>
        </div>
        <div className="grid grid-cols-[34px_1fr] gap-2">
          <div className="grid grid-rows-7 gap-1 text-[10px] text-muted-foreground">
            {["一", "", "三", "", "五", "", "日"].map((day, index) => <span key={index} className="flex h-3 items-center sm:h-3.5 lg:h-4 2xl:h-5">{day}</span>)}
          </div>
          <div className="grid grid-flow-col auto-cols-[12px] justify-center gap-1 sm:auto-cols-[14px] lg:auto-cols-[16px] 2xl:auto-cols-[20px]" role="list" aria-label="每日 Token 用量热力图">
            {weeks.map((week, weekIndex) => (
              <div key={weekIndex} className="grid grid-rows-7 gap-1">
                {Array.from({ length: 7 }, (_, dayIndex) => {
                  const day = week[dayIndex]
                  return day ? (
                    <div key={day.date} role="listitem" className="size-3 sm:size-3.5 lg:size-4 2xl:size-5">
                      <ShadTooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            aria-label={`${formatDate(day.date, true)}：${formatNumber(day.tokens)} Token`}
                            className={`h-full w-full rounded-[3px] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${colors[level(day.tokens)]}`}
                          />
                        </TooltipTrigger>
                        <TooltipContent side="top" sideOffset={8} className="flex flex-col items-start gap-1">
                          <span className="font-medium">{formatDate(day.date, true)}</span>
                          <span>总 Token：{formatNumber(day.tokens)}</span>
                          <span>输入：{formatNumber(day.promptTokens ?? 0)} · 输出：{formatNumber(day.completionTokens ?? 0)}</span>
                          <span>请求：{formatNumber(day.requests)} · 花费：{formatCurrency(day.spend)}</span>
                        </TooltipContent>
                      </ShadTooltip>
                    </div>
                  ) : <span key={`empty-${weekIndex}-${dayIndex}`} className="size-3 sm:size-3.5 lg:size-4 2xl:size-5" />
                })}
              </div>
            ))}
          </div>
        </div>
        <div className="mt-4 flex items-center justify-end gap-2 text-xs text-muted-foreground">
          <span>少</span>{colors.map((color, index) => <span key={index} className={`h-3 w-3 rounded-[3px] ${color}`} />)}<span>多</span>
        </div>
      </div>
    </div>
  )
}

export function ChartAreaInteractive({ data: _summaryData }: { data: UsageDay[] }) {
  const today = dateInShanghai()
  const currentYear = Number(today.slice(0, 4))
  const [range, setRange] = React.useState("90d")
  const [startDate, setStartDate] = React.useState(shiftDate(today, -89))
  const [endDate, setEndDate] = React.useState(today)
  const [value, setValue] = React.useState("")
  const [availableModels, setAvailableModels] = React.useState<string[]>([])
  const [view, setView] = React.useState<View>("line")
  const [result, setResult] = React.useState<TrendResponse | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState("")
  const [filtersOpen, setFiltersOpen] = React.useState(false)
  const [heatmapYear, setHeatmapYear] = React.useState(currentYear)
  const [refreshNonce, setRefreshNonce] = React.useState(0)
  const forceRefresh = React.useRef(false)
  const heatmapYears = Array.from({ length: 5 }, (_, index) => currentYear - index)

  React.useEffect(() => {
    const controller = new AbortController()
    const params = new URLSearchParams({
      startDate: view === "heatmap" ? `${heatmapYear}-01-01` : startDate,
      endDate: view === "heatmap" ? (heatmapYear === currentYear ? today : `${heatmapYear}-12-31`) : endDate,
      model: value,
    })
    const cacheKey = params.toString()
    const cached = readTrendCache(cacheKey)
    const shouldForceRefresh = forceRefresh.current
    forceRefresh.current = false
    if (cached) {
      setResult(cached.result)
      setAvailableModels((current) => [...new Set([...current, ...(cached.result.options?.model ?? [])])].sort((a, b) => a.localeCompare(b)))
    }
    setLoading(!cached || shouldForceRefresh)
    setError("")
    if (cached?.fresh && !shouldForceRefresh) return () => controller.abort()

    void fetch(`/api/usage/trend?${params}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json()
        if (!response.ok) throw new Error(payload.error ?? "无法读取 Token 趋势")
        if (controller.signal.aborted) return
        writeTrendCache(cacheKey, payload)
        setAvailableModels((current) => [...new Set([...current, ...(payload.options?.model ?? [])])].sort((a, b) => a.localeCompare(b)))
        setResult(payload)
      })
      .catch((cause) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return
        if (cached) return
        setError(cause instanceof Error ? cause.message : "无法读取 Token 趋势")
        setResult(null)
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [startDate, endDate, value, view, today, currentYear, heatmapYear, refreshNonce])

  const refreshTrend = () => {
    if (loading) return
    forceRefresh.current = true
    setRefreshNonce((nonce) => nonce + 1)
  }

  const days = result?.days ?? []
  const total = days.reduce((sum, day) => sum + day.tokens, 0)
  const selectedOptions = availableModels.length ? availableModels : result?.options?.model ?? []
  const onPreset = (days: number) => {
    const end = dateInShanghai()
    setRange(`${days}d`)
    setEndDate(end)
    setStartDate(shiftDate(end, -(days - 1)))
  }
  const setCustomDate = (kind: "start" | "end", next: string) => {
    setRange("custom")
    if (kind === "start") setStartDate(next)
    else setEndDate(next)
  }

  return (
    <Card className="@container/card gap-3 py-3">
      <CardHeader className="gap-3">
        <div className="flex flex-col gap-1">
          <CardTitle>Token 用量趋势</CardTitle>
          <CardDescription>按日查看输入与输出 Token；热力图按全年展示，悬停可查看日期明细</CardDescription>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={refreshTrend} disabled={loading} aria-label="刷新用量趋势">
            <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
            {loading ? "刷新中…" : "刷新"}
          </Button>
          <div className="flex h-9 items-center gap-1 rounded-lg border bg-background p-1" aria-label="图表视图">
            <button type="button" onClick={() => setView("line")} aria-pressed={view === "line"} className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${view === "line" ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
              <ChartNoAxesCombined className="size-3.5" />折线图
            </button>
            <button type="button" onClick={() => setView("heatmap")} aria-pressed={view === "heatmap"} className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${view === "heatmap" ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
              <Activity className="size-3.5" />热力图
            </button>
          </div>
          {view === "line" && [7, 30, 90].map((days) => (
            <button key={days} type="button" onClick={() => onPreset(days)} aria-pressed={range === `${days}d`} className={`h-9 rounded-md px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${range === `${days}d` ? "bg-primary text-primary-foreground" : "border bg-background hover:bg-accent"}`}>
              {days} 天
            </button>
          ))}
          <button
            type="button"
            aria-expanded={filtersOpen}
            aria-controls="usage-filter-panel"
            onClick={() => setFiltersOpen((open) => !open)}
            className={`inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${filtersOpen ? "border-primary text-primary" : "bg-background"}`}
          >
            <Filter className="size-4" />筛选{value ? <span className="size-1.5 rounded-full bg-primary" /> : null}<ChevronDown className={`size-3.5 transition-transform ${filtersOpen ? "rotate-180" : ""}`} />
          </button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setValue("")
              onPreset(90)
              setHeatmapYear(currentYear)
            }}
            disabled={!value && range === "90d" && (view !== "heatmap" || heatmapYear === currentYear)}
          >
            重置筛选
          </Button>
        </div>
        {filtersOpen ? <div id="usage-filter-panel" className="grid gap-4 rounded-lg border bg-muted/20 p-4 sm:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-2">
            <span className="text-sm font-medium">模型</span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className="inline-flex h-9 w-full items-center justify-between gap-2 rounded-md border bg-background px-3 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <span className={value ? "truncate text-foreground" : "text-muted-foreground"}>{value || "选择模型…"}</span>
                  <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-72 w-(--radix-dropdown-menu-trigger-width) overflow-y-auto">
                <DropdownMenuLabel>选择模型</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={value || "__all_models__"} onValueChange={(next) => setValue(next === "__all_models__" ? "" : next)}>
                  <DropdownMenuRadioItem value="__all_models__">全部模型</DropdownMenuRadioItem>
                  {selectedOptions.map((option) => <DropdownMenuRadioItem value={option} key={option}>{option}</DropdownMenuRadioItem>)}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {view === "line" ? <div className="flex min-w-0 flex-col gap-2">
            <span className="text-sm font-medium">日期范围</span>
            <div className="flex flex-wrap items-center gap-2">
              <CalendarDays className="size-4 text-muted-foreground" />
              <label className="sr-only" htmlFor="usage-start-date">开始日期</label>
              <input id="usage-start-date" type="date" value={startDate} max={endDate} onChange={(event) => setCustomDate("start", event.target.value)} className="h-9 min-w-0 flex-1 rounded-md border bg-background px-2.5 text-sm" />
              <span className="text-sm text-muted-foreground">至</span>
              <label className="sr-only" htmlFor="usage-end-date">结束日期</label>
              <input id="usage-end-date" type="date" value={endDate} min={startDate} max={today} onChange={(event) => setCustomDate("end", event.target.value)} className="h-9 min-w-0 flex-1 rounded-md border bg-background px-2.5 text-sm" />
            </div>
          </div> : null}
          {view === "line" ? <div className="flex items-center text-sm text-muted-foreground sm:col-span-2">所选范围 <strong className="ml-1 font-medium text-foreground">{formatNumber(total)} Token</strong></div> : null}
        </div> : null}
      </CardHeader>
      <CardContent className="px-4 pb-3 pt-0 sm:px-6">
        {view === "heatmap" ? <div className="mx-auto flex w-full max-w-[1660px] flex-col items-center gap-3 lg:flex-row lg:justify-center">
          <div className="w-full min-w-0 lg:flex-1">
            {error ? <div role="alert" className="flex h-40 w-full items-center justify-center rounded-lg border border-destructive/30 bg-destructive/5 px-5 text-center text-sm text-destructive">{error}</div> : loading ? (
              <div className="flex h-40 items-center justify-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />正在加载用量数据…</div>
            ) : days.some((day) => day.tokens > 0) ? <div className="w-full"><Heatmap data={days} year={heatmapYear} /></div> : (
              <div className="flex h-40 flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground"><Activity className="size-5" />此日期范围内没有 Token 用量</div>
            )}
          </div>
          <nav aria-label="按年份查看热力图" className="grid grid-cols-5 gap-2 lg:flex lg:w-24 lg:shrink-0 lg:flex-col lg:gap-0.5">
            {heatmapYears.map((year) => (
              <button
                key={year}
                type="button"
                aria-pressed={heatmapYear === year}
                onClick={() => setHeatmapYear(year)}
                className={`h-9 rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${heatmapYear === year ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}
              >
                {year}
              </button>
            ))}
          </nav>
        </div> : error ? <div role="alert" className="flex min-h-[250px] items-center justify-center rounded-lg border border-destructive/30 bg-destructive/5 px-5 text-center text-sm text-destructive">{error}</div> : loading ? (
          <div className="flex h-[250px] items-center justify-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />正在加载用量数据…</div>
        ) : days.length && days.some((day) => day.tokens > 0) ? (
          <div className="h-[270px] w-full" role="img" aria-label="每日输入与输出 Token 折线图">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={days} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} minTickGap={32} tickFormatter={(date) => formatDate(date)} className="text-xs" />
                <YAxis tickLine={false} axisLine={false} width={52} tickFormatter={(n) => new Intl.NumberFormat("zh-CN", { notation: "compact" }).format(n)} className="text-xs" />
                <Tooltip labelFormatter={(date) => formatDate(String(date), true)} formatter={(amount, name) => [formatNumber(Number(amount)), name === "promptTokens" ? "输入 Token" : "输出 Token"]} contentStyle={{ borderRadius: 10, borderColor: "var(--border)", background: "var(--popover)", color: "var(--popover-foreground)" }} />
                <Line name="promptTokens" dataKey="promptTokens" type="monotone" stroke="var(--chart-1)" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                <Line name="completionTokens" dataKey="completionTokens" type="monotone" stroke="var(--chart-2)" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="flex h-[250px] flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground"><Activity className="size-5" />此日期范围内没有 Token 用量</div>
        )}
        {view === "line" && !error && !loading && days.length > 0 && <div className="mt-1 flex justify-center gap-5 text-xs text-muted-foreground"><span className="inline-flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-[var(--chart-1)]" />输入 Token</span><span className="inline-flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-[var(--chart-2)]" />输出 Token</span></div>}
      </CardContent>
    </Card>
  )
}
