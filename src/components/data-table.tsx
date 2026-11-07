import * as React from "react"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs"
import { formatCurrency, formatDate, formatNumber, type UsageDay } from "@/lib/usage"

export function DataTable({ data }: { data: UsageDay[] }) {
  const [filter, setFilter] = React.useState("")
  const total = data.reduce((sum, day) => ({
    tokens: sum.tokens + day.tokens,
    requests: sum.requests + day.requests,
    spend: sum.spend + day.spend,
  }), { tokens: 0, requests: 0, spend: 0 })
  const rows = [...data].reverse().filter((day) => day.date.includes(filter.trim()))

  return (
    <Tabs defaultValue="daily" className="w-full flex-col justify-start gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 lg:px-6">
        <TabsList className="**:data-[slot=badge]:size-5 **:data-[slot=badge]:rounded-full **:data-[slot=badge]:bg-muted-foreground/30 **:data-[slot=badge]:px-1">
          <TabsTrigger value="daily">每日用量 <Badge variant="secondary">{data.length}</Badge></TabsTrigger>
          <TabsTrigger value="summary">7 天汇总</TabsTrigger>
        </TabsList>
        <Input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="按日期筛选（YYYY-MM-DD）"
          aria-label="按日期筛选"
          className="w-full sm:w-64"
        />
      </div>
      <TabsContent value="daily" className="relative flex flex-col gap-4 overflow-auto px-4 lg:px-6">
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-muted">
              <TableRow>
                <TableHead>日期</TableHead>
                <TableHead className="text-right">Token 总量</TableHead>
                <TableHead className="text-right">请求次数</TableHead>
                <TableHead className="text-right">Spend (USD)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length ? rows.map((day) => (
                <TableRow key={day.date}>
                  <TableCell className="font-medium">{formatDate(day.date, true)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(day.tokens)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(day.requests)}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{formatCurrency(day.spend)}</TableCell>
                </TableRow>
              )) : (
                <TableRow><TableCell colSpan={4} className="h-24 text-center text-muted-foreground">{data.length ? "没有匹配的日期" : "等待 LiteLLM 用量数据"}</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </TabsContent>
      <TabsContent value="summary" className="relative flex flex-col gap-4 overflow-auto px-4 lg:px-6">
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-muted">
              <TableRow>
                <TableHead>统计周期</TableHead>
                <TableHead className="text-right">Token 总量</TableHead>
                <TableHead className="text-right">请求次数</TableHead>
                <TableHead className="text-right">Spend (USD)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell className="font-medium">近 7 天</TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(total.tokens)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(total.requests)}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{formatCurrency(total.spend)}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </TabsContent>
    </Tabs>
  )
}
