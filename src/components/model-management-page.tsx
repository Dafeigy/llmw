import * as React from 'react'
import { LoaderCircle, Plus, RefreshCw, Tags, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'

type ManagedModel = { model: string; tags: string[] }

export function ModelManagementPage() {
  const [models, setModels] = React.useState<ManagedModel[]>([])
  const [tags, setTags] = React.useState<string[]>([])
  const [selectedModels, setSelectedModels] = React.useState<string[]>([])
  const [selectedTags, setSelectedTags] = React.useState<string[]>([])
  const [newTag, setNewTag] = React.useState('')
  const [filter, setFilter] = React.useState('')
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [notice, setNotice] = React.useState('')

  const refresh = React.useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true)
    try {
      const response = await fetch('/api/models', { cache: 'no-store' })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? '无法获取网关模型')
      setModels(data.models ?? [])
      setTags(data.tags ?? [])
      setSelectedModels((current) => current.filter((name) => (data.models ?? []).some((model: ManagedModel) => model.model === name)))
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '读取模型失败')
    } finally { if (showLoading) setLoading(false) }
  }, [])

  React.useEffect(() => { void refresh(true) }, [refresh])

  const runMutation = async (action: () => Promise<Response>, success: string) => {
    setBusy(true); setError(''); setNotice('')
    try {
      const response = await action()
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? '保存失败')
      if (data.models) setModels(data.models)
      if (data.tags ?? data.catalog) setTags(data.tags ?? data.catalog)
      if (data.assignments) setModels((current) => current.map((model) => ({ ...model, tags: data.assignments[model.model] ?? [] })))
      setNotice(success)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败') }
    finally { setBusy(false) }
  }

  const createTag = async (event: React.FormEvent) => {
    event.preventDefault()
    const tag = newTag.trim()
    if (!tag) return
    await runMutation(() => fetch('/api/models/tags', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tag }) }), 'Tag 已新增。')
    setNewTag('')
  }

  const mutateAssignments = (operation: 'add' | 'remove') => runMutation(
    () => fetch('/api/models/tags/assignments', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ models: selectedModels, tags: selectedTags, operation }) }),
    operation === 'add' ? '已为所选模型新增 tag。' : '已从所选模型删除 tag。',
  )

  const visibleModels = models.filter((model) => `${model.model} ${model.tags.join(' ')}`.toLocaleLowerCase().includes(filter.toLocaleLowerCase()))
  const toggleModel = (name: string, checked: boolean | 'indeterminate') => setSelectedModels((current) => checked ? [...new Set([...current, name])] : current.filter((item) => item !== name))
  const toggleTag = (tag: string, checked: boolean | 'indeterminate') => setSelectedTags((current) => checked ? [...new Set([...current, tag])] : current.filter((item) => item !== tag))

  return (
    <div className="mx-auto flex w-full max-w-[1680px] flex-1 flex-col gap-5 px-4 py-5 lg:px-6 lg:py-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div><div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground"><Tags className="size-4" />网关模型与分类</div><h2 className="text-2xl font-semibold tracking-tight">模型管理</h2><p className="mt-1 text-sm text-muted-foreground">管理当前 LiteLLM 网关中的模型和自定义 tag</p></div>
        <Button variant="outline" onClick={() => void refresh(true)} disabled={loading}><RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />刷新模型</Button>
      </div>
      {error && <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">{error}</div>}
      {notice && <div role="status" className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-300">{notice}</div>}

      <Card>
        <CardHeader className="border-b"><CardTitle>Tag 管理</CardTitle><CardDescription>Tag 保存到 PostgreSQL，可批量应用于多个模型。</CardDescription></CardHeader>
        <CardContent className="space-y-5 pt-5">
          <form onSubmit={(event) => void createTag(event)} className="flex max-w-xl gap-2"><Input aria-label="新 tag 名称" placeholder="输入新 tag 名称" maxLength={48} value={newTag} onChange={(event) => setNewTag(event.target.value)} /><Button type="submit" disabled={busy || !newTag.trim()}><Plus className="size-4" />新增 tag</Button></form>
          <div className="flex flex-wrap gap-2">{tags.length ? tags.map((tag) => <span key={tag} className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-sm"><Badge variant="secondary">{tag}</Badge><button className="rounded p-0.5 text-muted-foreground hover:text-destructive" title={`删除 tag ${tag}`} aria-label={`删除 tag ${tag}`} disabled={busy} onClick={() => void runMutation(() => fetch(`/api/models/tags/${encodeURIComponent(tag)}`, { method: 'DELETE' }), 'Tag 已删除。')}><Trash2 className="size-3.5" /></button></span>) : <p className="text-sm text-muted-foreground">暂无 tag</p>}</div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="gap-3 border-b sm:flex-row sm:items-center sm:justify-between"><div><CardTitle>网关模型 <Badge variant="outline" className="ml-2">{models.length}</Badge></CardTitle><CardDescription className="mt-1">从 LiteLLM `/model/info` 获取当前模型；选中模型后可批量添加或移除 tag。</CardDescription></div><Input className="sm:max-w-xs" aria-label="搜索模型" placeholder="搜索模型或 tag" value={filter} onChange={(event) => setFilter(event.target.value)} /></CardHeader>
        <CardContent className="space-y-4 p-0">
          <div className="flex flex-col gap-3 border-b bg-muted/20 px-4 py-3 lg:flex-row lg:items-center lg:justify-between lg:px-6">
            <div className="flex flex-wrap items-center gap-3 text-sm"><label className="flex items-center gap-2"><Checkbox checked={visibleModels.length > 0 && visibleModels.every((model) => selectedModels.includes(model.model))} onCheckedChange={(checked) => setSelectedModels((current) => checked ? [...new Set([...current, ...visibleModels.map((model) => model.model)])] : current.filter((name) => !visibleModels.some((model) => model.model === name)))} /><span>选择当前列表</span></label><span className="text-muted-foreground">已选 {selectedModels.length} 个模型</span></div>
            <div className="flex flex-wrap items-center gap-2">
              {tags.map((tag) => <label key={tag} className="flex items-center gap-1.5 text-xs"><Checkbox checked={selectedTags.includes(tag)} onCheckedChange={(checked) => toggleTag(tag, checked)} />{tag}</label>)}
              <Button size="sm" variant="outline" disabled={busy || !selectedModels.length || !selectedTags.length} onClick={() => void mutateAssignments('add')}>批量添加 tag</Button>
              <Button size="sm" variant="outline" disabled={busy || !selectedModels.length || !selectedTags.length} onClick={() => void mutateAssignments('remove')}>批量删除 tag</Button>
            </div>
          </div>
          {loading ? <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />正在读取模型…</div> : !visibleModels.length ? <div className="py-14 text-center text-sm text-muted-foreground">{models.length ? '没有匹配的模型' : '暂无网关模型'}</div> : <div className="divide-y">{visibleModels.map((model) => <div key={model.model} className="flex items-start gap-3 px-4 py-4 lg:px-6"><Checkbox className="mt-0.5" checked={selectedModels.includes(model.model)} onCheckedChange={(checked) => toggleModel(model.model, checked)} aria-label={`选择模型 ${model.model}`} /><div className="min-w-0 flex-1"><p className="break-all text-sm font-medium">{model.model}</p><div className="mt-2 flex flex-wrap gap-1.5">{model.tags.length ? model.tags.map((tag) => <Badge key={tag} variant="secondary">{tag}</Badge>) : <span className="text-xs text-muted-foreground">未设置 tag</span>}</div></div></div>)}</div>}
        </CardContent>
      </Card>
      {busy && <span className="sr-only" role="status">正在保存</span>}
    </div>
  )
}
