/**
 * dsh-plugin-workshop 统计服务（Phase A）— Cloudflare Worker + D1 参考实现
 *
 * 端点：
 * - POST /events   { full_name, event: 'install'|'update'|'uninstall', install_id }
 *                  记录一条事件并更新计数器（工坊宿主侧上报，匿名）
 * - GET  /stats?repos=owner/repo,owner/repo2
 *                  返回每个仓库的 totals（装机/更新/卸载）+ 近 7 天装机与净增长
 * - GET  /trending?days=7&limit=20
 *                  按时间窗口内净增长排序（真·飙升榜）
 *
 * 隐私：仅记录 full_name + 事件类型 + 匿名安装 ID（随机哈希），无用户身份、无路径。
 * 工坊在服务不可达时静默降级（零服务器模式照常可用）。
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-store',
    }
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })

    try {
      if (request.method === 'POST' && url.pathname === '/events') {
        const body = await request.json()
        const full = String(body.full_name || '')
        const event = String(body.event || '')
        const installId = String(body.install_id || '')
        if (!/^[\w.-]+\/[\w.-]+$/.test(full)) return json({ ok: false, error: 'bad full_name' }, 400, cors)
        if (!/^(install|update|uninstall)$/.test(event)) return json({ ok: false, error: 'bad event' }, 400, cors)
        if (!/^[A-Za-z0-9._-]{8,64}$/.test(installId)) return json({ ok: false, error: 'bad install_id' }, 400, cors)
        await recordEvent(env.DB, full, event, installId)
        return json({ ok: true }, 200, cors)
      }

      if (request.method === 'GET' && url.pathname === '/stats') {
        const repos = (url.searchParams.get('repos') || '').split(',').map((s) => s.trim()).filter((s) => /^[\w.-]+\/[\w.-]+$/.test(s)).slice(0, 50)
        if (repos.length === 0) return json({ ok: true, stats: {} }, 200, cors)
        const stats = {}
        for (const repo of repos) stats[repo] = await repoStats(env.DB, repo)
        return json({ ok: true, stats }, 200, cors)
      }

      if (request.method === 'GET' && url.pathname === '/trending') {
        const days = clampInt(url.searchParams.get('days'), 1, 90, 7)
        const limit = clampInt(url.searchParams.get('limit'), 1, 100, 20)
        const rows = await trending(env.DB, days, limit)
        return json({ ok: true, days, trending: rows }, 200, cors)
      }

      return json({ ok: false, error: 'unknown route' }, 404, cors)
    } catch (e) {
      return json({ ok: false, error: String((e && e.message) || e) }, 500, cors)
    }
  },
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors } })
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(String(value), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

function dayOf(unixSeconds) {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10)
}

/** 记录事件：插入 events 表 + upsert counters 表。 */
async function recordEvent(db, repo, event, installId) {
  const now = Math.floor(Date.now() / 1000)
  await db.prepare('INSERT INTO events (repo, event, install_id, day, at) VALUES (?, ?, ?, ?, ?)')
    .bind(repo, event, installId, dayOf(now), now).run()
  const col = event === 'install' ? 'installs' : event === 'update' ? 'updates' : 'uninstalls'
  await db.prepare(`UPDATE counters SET ${col} = ${col} + 1, last_seen = ? WHERE repo = ?`).bind(now, repo).run()
}

/** 单仓库统计：totals + 近 7 天装机与净增长。 */
async function repoStats(db, repo) {
  const c = await db.prepare('SELECT installs, updates, uninstalls, last_seen FROM counters WHERE repo = ?').bind(repo).first()
  const since = dayOf(Math.floor(Date.now() / 1000) - 7 * 86400)
  const i7 = await db.prepare('SELECT COUNT(*) AS n FROM events WHERE repo = ? AND event = ? AND day >= ?').bind(repo, 'install', since).first()
  const u7 = await db.prepare('SELECT COUNT(*) AS n FROM events WHERE repo = ? AND event = ? AND day >= ?').bind(repo, 'uninstall', since).first()
  return {
    installs: c ? c.installs : 0,
    updates: c ? c.updates : 0,
    uninstalls: c ? c.uninstalls : 0,
    lastSeen: c ? c.last_seen : 0,
    installs7d: i7 ? i7.n : 0,
    net7d: (i7 ? i7.n : 0) - (u7 ? u7.n : 0),
  }
}

/** 时间窗口内按净增长排序（真·飙升榜）。 */
async function trending(db, days, limit) {
  const since = dayOf(Math.floor(Date.now() / 1000) - days * 86400)
  const rows = await db.prepare(
    'SELECT repo, SUM(event = ?) AS installs, SUM(event = ?) AS uninstalls FROM events WHERE day >= ? GROUP BY repo'
  ).bind('install', 'uninstall', since).all()
  const out = (rows.results || rows).map((r) => ({
    repo: r.repo,
    installs: Number(r.installs) || 0,
    uninstalls: Number(r.uninstalls) || 0,
    net: (Number(r.installs) || 0) - (Number(r.uninstalls) || 0),
  }))
  out.sort((a, b) => b.net - a.net || b.installs - a.installs)
  return out.slice(0, limit)
}
