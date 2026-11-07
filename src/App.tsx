import * as React from "react"
import { AppSidebar } from "@/components/app-sidebar"
import { ChartAreaInteractive } from "@/components/chart-area-interactive"
import { DataTable } from "@/components/data-table"
import { SectionCards } from "@/components/section-cards"
import { SiteHeader } from "@/components/site-header"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Button } from "@/components/ui/button"
import { RefreshCw } from "lucide-react"
import type { UsageDay } from "@/lib/usage"
import { ModelHealthPage } from "@/components/model-health-page"
import { ModelManagementPage } from "@/components/model-management-page"

type UsageResponse = { days: UsageDay[]; today: UsageDay; error?: string }

const overviewPage = "用量概览"

export default function App() {
  const [activePage, setActivePage] = React.useState(overviewPage)
  const [usage, setUsage] = React.useState<UsageResponse | null>(null)
  const [error, setError] = React.useState("")
  const [refreshing, setRefreshing] = React.useState(false)

  const refresh = React.useCallback(async (manual = false) => {
    if (manual) setRefreshing(true)
    try {
      const response = await fetch("/api/usage", { cache: "no-store" })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error ?? "无法获取 LiteLLM 用量")
      setUsage(payload)
      setError("")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "连接 LiteLLM 失败")
    } finally {
      if (manual) setRefreshing(false)
    }
  }, [])

  React.useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 60_000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const days = usage?.days ?? []
  const today = usage?.today ?? { date: "", tokens: 0, requests: 0, spend: 0 }

  return (
    <TooltipProvider>
      <SidebarProvider
        style={{
          "--sidebar-width": "calc(var(--spacing) * 72)",
          "--header-height": "calc(var(--spacing) * 12)",
        } as React.CSSProperties}
      >
        <AppSidebar
          variant="inset"
          activePage={activePage}
          onPageChange={setActivePage}
        />
        <SidebarInset>
          <SiteHeader activePage={activePage} />
          {activePage === overviewPage ? (
            <div className="flex flex-1 flex-col">
              <div className="@container/main mx-auto flex w-full max-w-[1680px] flex-1 flex-col gap-2">
                <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
                  {error && (
                    <div role="alert" className="mx-4 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive lg:mx-6">
                      LiteLLM 数据暂不可用：{error}
                    </div>
                  )}
                  <div className="flex items-center justify-between px-4 lg:px-6">
                    <h2 className="text-lg font-semibold">数据概览</h2>
                    <Button variant="outline" size="sm" onClick={() => void refresh(true)} disabled={refreshing} aria-label="刷新数据概览">
                      <RefreshCw className={`size-4 ${refreshing ? "animate-spin" : ""}`} />
                      {refreshing ? "刷新中…" : "刷新"}
                    </Button>
                  </div>
                  <SectionCards today={today} week={days} />
                  <div className="px-4 lg:px-6">
                    <ChartAreaInteractive data={days} />
                  </div>
                  <DataTable data={days} />
                </div>
              </div>
            </div>
          ) : (
            activePage === "模型健康" ? <ModelHealthPage /> : activePage === "模型管理" ? <ModelManagementPage /> : <div className="flex flex-1" aria-label={`${activePage} Empty`} />
          )}
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}
