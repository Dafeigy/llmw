import { Pool } from 'pg'
import { createClient, type RedisClientType } from 'redis'

type HealthSnapshot = { config: unknown; checks: unknown[]; events: unknown[] }

const databaseUrl = process.env.DATABASE_URL
const redisUrl = process.env.REDIS_URL
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : undefined
let redis: RedisClientType | undefined

export async function initializePersistence() {
  if (pool) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS model_health_state (
        id SMALLINT PRIMARY KEY CHECK (id = 1),
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS model_tag_catalog (
        tag TEXT PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS model_tag_assignments (
        model_name TEXT PRIMARY KEY,
        tags TEXT[] NOT NULL DEFAULT '{}',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
  }

  if (redisUrl) {
    redis = createClient({ url: redisUrl })
    redis.on('error', (error) => console.error('Redis connection error:', error.message))
    try { await redis.connect() }
    catch (error) { console.error('Redis unavailable; usage cache disabled:', error instanceof Error ? error.message : error) }
  }
}

export async function getModelTagData(): Promise<{ assignments: Record<string, string[]>; catalog: string[] }> {
  if (!pool) throw new Error('模型 tag 管理需要配置 DATABASE_URL 并连接 PostgreSQL。')
  const [assignments, catalog] = await Promise.all([
    pool.query<{ model_name: string; tags: string[] }>('SELECT model_name, tags FROM model_tag_assignments'),
    pool.query<{ tag: string }>('SELECT tag FROM model_tag_catalog ORDER BY tag'),
  ])
  return {
    assignments: Object.fromEntries(assignments.rows.map((row) => [row.model_name, row.tags ?? []])),
    catalog: catalog.rows.map((row) => row.tag),
  }
}

export async function createModelTag(tag: string) {
  if (!pool) throw new Error('模型 tag 管理需要配置 DATABASE_URL 并连接 PostgreSQL。')
  await pool.query('INSERT INTO model_tag_catalog (tag) VALUES ($1) ON CONFLICT (tag) DO NOTHING', [tag])
}

export async function deleteModelTag(tag: string) {
  if (!pool) throw new Error('模型 tag 管理需要配置 DATABASE_URL 并连接 PostgreSQL。')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('DELETE FROM model_tag_catalog WHERE tag = $1', [tag])
    await client.query('UPDATE model_tag_assignments SET tags = array_remove(tags, $1), updated_at = NOW() WHERE $1 = ANY(tags)', [tag])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
}

export async function updateModelTags(models: string[], tags: string[], operation: 'add' | 'remove') {
  if (!pool) throw new Error('模型 tag 管理需要配置 DATABASE_URL 并连接 PostgreSQL。')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const known = await client.query<{ tag: string }>('SELECT tag FROM model_tag_catalog WHERE tag = ANY($1::text[])', [tags])
    if (known.rows.length !== tags.length) throw new Error('包含尚未创建的 tag。')
    for (const model of models) {
      if (operation === 'add') {
        await client.query(`INSERT INTO model_tag_assignments (model_name, tags) VALUES ($1, $2::text[])
          ON CONFLICT (model_name) DO UPDATE SET tags = ARRAY(SELECT DISTINCT unnest(model_tag_assignments.tags || EXCLUDED.tags)), updated_at = NOW()`, [model, tags])
      } else {
        await client.query(`INSERT INTO model_tag_assignments (model_name, tags) VALUES ($1, '{}')
          ON CONFLICT (model_name) DO UPDATE SET tags = ARRAY(SELECT unnest(model_tag_assignments.tags) EXCEPT SELECT unnest($2::text[])), updated_at = NOW()`, [model, tags])
      }
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
}

export async function loadHealthSnapshot(): Promise<HealthSnapshot | null> {
  if (!pool) return null
  const result = await pool.query<{ payload: HealthSnapshot }>('SELECT payload FROM model_health_state WHERE id = 1')
  return result.rows[0]?.payload ?? null
}

export async function saveHealthSnapshot(snapshot: HealthSnapshot) {
  if (!pool) return false
  await pool.query(
    `INSERT INTO model_health_state (id, payload, updated_at) VALUES (1, $1::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`,
    [JSON.stringify(snapshot)],
  )
  return true
}

export async function getCachedJson<T>(key: string): Promise<T | null> {
  if (!redis?.isReady) return null
  try {
    const value = await redis.get(key)
    return value ? JSON.parse(value) as T : null
  } catch (error) {
    console.error('Redis cache read failed:', error instanceof Error ? error.message : error)
    return null
  }
}

export async function setCachedJson(key: string, value: unknown, ttlSeconds: number) {
  if (!redis?.isReady) return
  try { await redis.set(key, JSON.stringify(value), { EX: ttlSeconds }) }
  catch (error) { console.error('Redis cache write failed:', error instanceof Error ? error.message : error) }
}

export async function closePersistence() {
  await Promise.allSettled([pool?.end(), redis?.isOpen ? redis.quit() : Promise.resolve()])
}
