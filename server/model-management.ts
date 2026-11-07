import type { Express, Request, Response } from 'express'
import express from 'express'
import { createModelTag, deleteModelTag, getModelTagData, updateModelTags } from './persistence.js'
import { discoverDeployments } from './model-health.js'

type AnyRecord = Record<string, unknown>

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '模型管理请求失败。'
}

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

export function registerModelManagement(app: Express) {
  const router = express.Router()

  router.get('/', async (_req, res) => {
    try {
      const [deployments, tagData] = await Promise.all([discoverDeployments(), getModelTagData()])
      const models = [...new Set(deployments.map((deployment) => deployment.model))].sort((a, b) => a.localeCompare(b))
      res.json({ models: models.map((model) => ({ model, tags: tagData.assignments[model] ?? [] })), tags: tagData.catalog })
    } catch (error) {
      res.status(502).json({ error: errorMessage(error) })
    }
  })

  router.post('/tags', async (req: Request, res: Response) => {
    const body = req.body as AnyRecord
    const tag = typeof body.tag === 'string' ? body.tag.trim() : ''
    if (!tag || tag.length > 48) {
      res.status(400).json({ error: 'tag 长度需为 1 到 48 个字符。' })
      return
    }
    try {
      await createModelTag(tag)
      res.json(await getModelTagData())
    } catch (error) { res.status(400).json({ error: errorMessage(error) }) }
  })

  router.delete('/tags/:tag', async (req, res) => {
    try {
      await deleteModelTag(req.params.tag!)
      res.json(await getModelTagData())
    } catch (error) { res.status(400).json({ error: errorMessage(error) }) }
  })

  router.put('/tags/assignments', async (req: Request, res: Response) => {
    const body = req.body as AnyRecord
    if (!stringList(body.models) || !body.models.length || body.models.some((model) => !model.trim())) {
      res.status(400).json({ error: '请选择至少一个模型。' })
      return
    }
    if (!stringList(body.tags) || !body.tags.length || body.tags.some((tag) => !tag.trim())) {
      res.status(400).json({ error: '请选择至少一个 tag。' })
      return
    }
    if (body.operation !== 'add' && body.operation !== 'remove') {
      res.status(400).json({ error: '操作类型无效。' })
      return
    }
    try {
      await updateModelTags([...new Set(body.models.map((model) => model.trim()))], [...new Set(body.tags.map((tag) => tag.trim()))], body.operation)
      res.json(await getModelTagData())
    } catch (error) { res.status(400).json({ error: errorMessage(error) }) }
  })

  app.use('/api/models', router)
}
