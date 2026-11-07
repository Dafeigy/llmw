export type UsageDay = {
  date: string
  tokens: number
  requests: number
  spend: number
  promptTokens?: number
  completionTokens?: number
}

export function formatNumber(value: number) {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(value)
}

export function formatCurrency(value: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: value < 1 ? 4 : 2,
    maximumFractionDigits: value < 1 ? 4 : 2,
  }).format(value)
}

export function formatDate(date: string, weekday = false) {
  return new Intl.DateTimeFormat('zh-CN', weekday
    ? { month: 'long', day: 'numeric', weekday: 'long' }
    : { month: 'short', day: 'numeric' },
  ).format(new Date(`${date}T12:00:00`))
}
