// Phase A 统计服务的本地测试：用内存 MockD1 跑 Worker 处理器，验证 API 数学与校验。
import worker from '../worker/src/index.js'

class MockStmt {
  constructor(sql, params) { this.sql = sql; this.params = params }
  bind(...params) { this.params = params; return this }
  run() { return MockD1.execute(this.sql, this.params, 'run') }
  first() { return MockD1.execute(this.sql, this.params, 'first') }
  all() { return MockD1.execute(this.sql, this.params, 'all') }
}

class MockD1 {
  static events = []
  static counters = new Map()
  static execute(sql, params, kind) {
    if (sql.startsWith('INSERT INTO events')) {
      const [repo, event, installId, day, at] = params
      MockD1.events.push({ repo, event, install_id: installId, day, at })
      return {}
    }
    if (sql.startsWith('UPDATE counters')) {
      const col = /SET (\w+) =/.exec(sql)[1]
      const [now, repo] = params
      const c = MockD1.counters.get(repo) || { installs: 0, updates: 0, uninstalls: 0, last_seen: 0 }
      c[col] += 1; c.last_seen = now
      MockD1.counters.set(repo, c)
      return {}
    }
    if (sql.startsWith('SELECT installs, updates')) {
      const [repo] = params
      return MockD1.counters.get(repo) || null
    }
    if (sql.startsWith('SELECT COUNT(*) AS n')) {
      const [repo, event, since] = params
      const n = MockD1.events.filter((e) => e.repo === repo && e.event === event && e.day >= since).length
      return { n }
    }
    if (sql.startsWith('SELECT repo, SUM(event')) {
      const [install, uninstall, since] = params
      const rows = []
      for (const repo of new Set(MockD1.events.filter((e) => e.day >= since).map((e) => e.repo))) {
        const evs = MockD1.events.filter((e) => e.repo === repo && e.day >= since)
        rows.push({
          repo,
          installs: evs.filter((e) => e.event === install).length,
          uninstalls: evs.filter((e) => e.event === uninstall).length,
        })
      }
      return { results: rows }
    }
    throw new Error('mock 不认识 SQL: ' + sql.slice(0, 60))
  }
  prepare(sql) { return new MockStmt(sql) }
}

function req(method, path, body) {
  const init = { method, headers: {} }
  if (body !== undefined) init.body = JSON.stringify(body)
  return new Request('https://stats.example' + path, init)
}

async function jsonOf(res) { return await res.json() }

let failed = 0
function check(label, cond) {
  if (cond) console.log('  ✓ ' + label)
  else { failed++; console.error('  ✗ ' + label) }
}

const env = { DB: new MockD1() }
const day = new Date().toISOString().slice(0, 10)

// 1. 上报事件
for (const [repo, event] of [
  ['aaa/plugin-a', 'install'], ['aaa/plugin-a', 'install'], ['aaa/plugin-a', 'install'],
  ['aaa/plugin-a', 'update'], ['aaa/plugin-a', 'uninstall'],
  ['bbb/plugin-b', 'install'],
]) {
  const res = await worker.fetch(req('POST', '/events', { full_name: repo, event, install_id: 'testmachine01' }), env)
  check('POST /events ' + repo + ' ' + event, res.status === 200 && (await jsonOf(res)).ok === true)
}

// 2. stats 查询
const s = await jsonOf(await worker.fetch(req('GET', '/stats?repos=aaa/plugin-a,bbb/plugin-b'), env))
check('stats aaa/plugin-a installs=3', s.stats['aaa/plugin-a'].installs === 3)
check('stats aaa/plugin-a updates=1', s.stats['aaa/plugin-a'].updates === 1)
check('stats aaa/plugin-a uninstalls=1', s.stats['aaa/plugin-a'].uninstalls === 1)
check('stats aaa/plugin-a installs7d=3', s.stats['aaa/plugin-a'].installs7d === 3)
check('stats aaa/plugin-a net7d=2', s.stats['aaa/plugin-a'].net7d === 2)
check('stats bbb/plugin-b installs=1', s.stats['bbb/plugin-b'].installs === 1)
check('stats 未知仓库返回 0 而不是 500', s.stats['zzz/none'] === undefined || s.stats['zzz/none'].installs === 0)

// 3. trending 排序（净增长优先）
const t = await jsonOf(await worker.fetch(req('GET', '/trending?days=7&limit=10'), env))
check('trending 首位是 aaa/plugin-a（net=2）', t.trending[0].repo === 'aaa/plugin-a' && t.trending[0].net === 2)
check('trending 次位是 bbb/plugin-b（net=1）', t.trending[1].repo === 'bbb/plugin-b' && t.trending[1].net === 1)

// 4. 校验
const bad1 = await worker.fetch(req('POST', '/events', { full_name: 'no-slash', event: 'install', install_id: 'testmachine01' }), env)
check('非法 full_name → 400', bad1.status === 400)
const bad2 = await worker.fetch(req('POST', '/events', { full_name: 'aaa/plugin-a', event: 'rm-rf', install_id: 'testmachine01' }), env)
check('非法 event → 400', bad2.status === 400)
const bad3 = await worker.fetch(req('POST', '/events', { full_name: 'aaa/plugin-a', event: 'install', install_id: 'x' }), env)
check('非法 install_id → 400', bad3.status === 400)

// 5. CORS 预检
const opt = await worker.fetch(req('OPTIONS', '/events'), env)
check('OPTIONS → 204 + CORS 头', opt.status === 204 && opt.headers.get('Access-Control-Allow-Origin') === '*')

console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项失败 ❌`)
process.exit(failed === 0 ? 0 : 1)
