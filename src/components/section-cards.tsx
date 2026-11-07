import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardAction,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { ActivityIcon, CoinsIcon, TrendingUpIcon, ZapIcon } from "lucide-react"
import { formatCurrency, formatNumber, type UsageDay } from "@/lib/usage"

export function SectionCards({ today, week }: { today: UsageDay; week: UsageDay[] }) {
  const totals = week.reduce((sum, day) => ({
    tokens: sum.tokens + day.tokens,
    requests: sum.requests + day.requests,
    spend: sum.spend + day.spend,
  }), { tokens: 0, requests: 0, spend: 0 })

  const metrics = [
    { label: "今日 Token 用量", value: formatNumber(today.tokens), unit: "tokens", detail: "Token 总量", icon: <ZapIcon />, badge: "今日" },
    { label: "今日请求次数", value: formatNumber(today.requests), unit: "次", detail: "API 请求", icon: <ActivityIcon />, badge: "今日" },
    { label: "今日 Spend 花费", value: formatCurrency(today.spend), unit: "USD", detail: "模型调用花费", icon: <CoinsIcon />, badge: "今日" },
    { label: "近 7 天 Spend", value: formatCurrency(totals.spend), unit: "USD", detail: `${formatNumber(totals.tokens)} tokens · ${formatNumber(totals.requests)} 次请求`, icon: <TrendingUpIcon />, badge: "近 7 天" },
  ]

  return (
    <div className="grid grid-cols-1 gap-4 px-4 *:data-[slot=card]:bg-gradient-to-t *:data-[slot=card]:from-primary/5 *:data-[slot=card]:to-card *:data-[slot=card]:shadow-xs lg:px-6 @xl/main:grid-cols-2 @5xl/main:grid-cols-4 dark:*:data-[slot=card]:bg-card">
      {metrics.map((metric) => (
        <Card key={metric.label} className="@container/card">
          <CardHeader>
            <CardDescription>{metric.label}</CardDescription>
            <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
              {metric.value}<span className="ml-2 text-xs font-normal text-muted-foreground">{metric.unit}</span>
            </CardTitle>
            <CardAction>
              <Badge variant="outline">{metric.badge}</Badge>
            </CardAction>
          </CardHeader>
          <CardFooter className="flex-col items-start gap-1.5 text-sm">
            <div className="line-clamp-1 flex gap-2 font-medium">{metric.detail}</div>
            <div className="text-muted-foreground">按北京时间统计</div>
          </CardFooter>
        </Card>
      ))}
    </div>
  )
}
