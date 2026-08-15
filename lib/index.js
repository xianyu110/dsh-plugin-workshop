/**
 * dsh-plugin-workshop（宿主侧）v1.6.0
 *
 * 智能一键安装/卸载：
 * - GET /dsh-plugin-workshop/api/status    → 插件目录、已安装列表（installed 合并视图）、profile 依赖/激活行/bundles、git 探测
 * - GET /dsh-plugin-workshop/api/probe     → 安装前预检（克隆检测结构，给出 installable/risky/manual 评级与理由，不执行安装）
 * - GET /dsh-plugin-workshop/api/install   → 临时克隆检测类型（需要 full_name）：
 *     bundle 型（package.json 声明 dsh.*）→ dsh plugin add github:...；
 *       若包声明 dsh.bundle.patch，dsh 会自动把它加入 profile bundles（补丁层自动激活），
 *       否则补写 profile 激活行（与旧版插件兼容）。
 *     nested 型（目录树中恰好一个 dsh 包，递归最深 4 层：皮肤合集 / packages/<name>/ 等 monorepo 布局）
 *                → 本地副本 + dsh plugin add link:<相对子目录>，同上判断激活方式
 *     preset 型（无 dsh 声明）            → 拷入 .agent-presets/<repo>
 * - GET /dsh-plugin-workshop/api/update    → bundle 型 pnpm update；nested/preset 型 git pull
 *                                           （参数 full_name / name(包名) / repo(短名) 三选一）
 * - GET /dsh-plugin-workshop/api/uninstall → 按安装方式逆向清理（参数同上）：
 *     pnpm remove 失败则不删任何文件（避免留下失效符号链接）；
 *     成功后防御性清理 node_modules 残留入口，并自动重启 dsh web，
 *     让运行中服务的热加载旧状态随进程一并清除（页面自动刷新到新清单）。
 *
 * 安全：
 * - 仅接受带自定义头 X-DSH-Workshop: 1 的请求（跨站请求无法带自定义头，
 *   且本服务不处理 CORS 预检，天然挡 CSRF）；
 * - full_name/name/repo 严格格式校验；clone 地址只允许 github.com。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

export const inject = ['webServer']

const API = '/dsh-plugin-workshop/api'

/** /probe 预检结果缓存（full → { at, result }，10 分钟 TTL）。 */
const probeCache = new Map()

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body)
}

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function presetsDir() {
  return join(dshHome(), '.agent-presets')
}

function profileDir() {
  return join(dshHome(), 'profiles', 'web')
}

function patchPath() {
  return join(profileDir(), 'cordis.patch.yml')
}

function gitAvailable() {
  try {
    const r = spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 10000, windowsHide: true })
    return r.status === 0
  } catch (e) {
    return false
  }
}

function guard(req) {
  return req.headers['x-dsh-workshop'] === '1'
}

function runCmd(cmd, args, timeoutMs) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs || 180000, windowsHide: true })
}

/** profile 的 package.json（dependencies / dsh.profile.bundles）。 */
function profileManifest() {
  try {
    return JSON.parse(readFileSync(join(profileDir(), 'package.json'), 'utf8'))
  } catch (e) {
    return null
  }
}

/** 已加入 profile bundles 的包名列表。 */
function profileBundles() {
  const m = profileManifest()
  const list = m && m.dsh && m.dsh.profile && Array.isArray(m.dsh.profile.bundles) ? m.dsh.profile.bundles : []
  return list.map((x) => String(x))
}

/** profile 依赖列表（含 spec），供客户端识别“已安装”。 */
function profileDeps() {
  const m = profileManifest()
  const deps = (m && m.dependencies) || {}
  const out = []
  for (const k of Object.keys(deps)) out.push({ name: k, spec: String(deps[k] || '') })
  return out
}

/** 从依赖 spec 解析仓库信息：{full: owner/repo 或 null, repo: 短名, fromLink: 是否 .agent-presets 本地链接}。 */
function repoOfSpec(spec) {
  const s = String(spec || '').trim()
  const gh = /github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[#/]|$)/.exec(s)
  if (gh) return { full: gh[1] + '/' + gh[2], repo: gh[2], fromLink: false }
  const gs = /^github:([\w.-]+)\/([\w.-]+)$/.exec(s)
  if (gs) return { full: gs[1] + '/' + gs[2], repo: gs[2], fromLink: false }
  const ln = /[\\/]\.agent-presets[\\/]([\w.-]+)([\\/]|$)/.exec(s)
  if (ln) return { full: null, repo: ln[1], fromLink: true }
  return null
}

/** 按仓库 spec 反查依赖名：github:owner/repo、*.git、或 .agent-presets/<repo>/ 的 link 路径。 */
function findDepByRepo(full, repoName) {
  const specMatch = String(full || '').toLowerCase()
  for (const d of profileDeps()) {
    const spec = d.spec.toLowerCase()
    const info = repoOfSpec(spec)
    if (info && info.full && info.full.toLowerCase() === specMatch) return d.name
    if (info && info.repo.toLowerCase() === String(repoName || '').toLowerCase()) return d.name
    if (spec.indexOf('github:' + specMatch) >= 0) return d.name
    if (spec.indexOf('github.com/' + specMatch) >= 0) return d.name
    if (spec.indexOf(specMatch + '.git') >= 0) return d.name
  }
  return null
}

/** 合并 deps / 激活行 / .agent-presets 目录为「已安装」视图数据。 */
function buildInstalled() {
  const rows = readPatchRows()
  const bundles = profileBundles()
  const deps = profileDeps()
  let dirs = []
  try {
    dirs = readdirSync(presetsDir(), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch (e) { dirs = [] }
  const out = []
  const seen = new Set()
  for (const d of deps) {
    const info = repoOfSpec(d.spec)
    const key = info && info.repo ? info.repo : d.name
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      key,
      pkgName: d.name,
      full: info ? info.full : null,
      repo: info ? info.repo : null,
      kind: info && info.fromLink ? 'nested' : 'bundle',
      spec: d.spec,
      active: bundles.indexOf(d.name) >= 0 || rows.some((r) => r.name === d.name),
      hasLocal: !!(info && info.fromLink && existsSync(join(presetsDir(), info.repo))),
    })
  }
  for (const r of rows) {
    if (deps.some((d) => d.name === r.name)) continue
    if (seen.has(r.id)) continue
    seen.add(r.id)
    out.push({ key: r.id, pkgName: r.name || r.id, full: null, repo: r.id, kind: 'bundle', spec: null, active: true, hasLocal: false, legacy: true })
  }
  for (const dir of dirs) {
    if (seen.has(dir)) continue
    seen.add(dir)
    out.push({ key: dir, pkgName: null, full: null, repo: dir, kind: 'preset', spec: null, active: false, hasLocal: true })
  }
  return out
}

/** 已安装包的 manifest（node_modules/<name>/package.json，跟随 link 软链）。 */
function installedManifest(pkgName) {
  try {
    return JSON.parse(readFileSync(join(profileDir(), 'node_modules', pkgName, 'package.json'), 'utf8'))
  } catch (e) {
    return null
  }
}

/** 包是否声明 dsh.bundle.patch（dsh plugin add 会自动把它加入 profile bundles）。 */
function declaresBundle(pkg) {
  return !!(pkg && pkg.dsh && pkg.dsh.bundle && typeof pkg.dsh.bundle.patch === 'string')
}

/** 解析 profile 激活行：{"id": "...", "name": "..."} 列表。 */
function readPatchRows() {
  const rows = []
  try {
    const lines = readFileSync(patchPath(), 'utf8').split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const m = /^\s*-\s*id:\s*([A-Za-z0-9_.-]+)\s*$/.exec(lines[i])
      if (!m) continue
      let name = ''
      if (i + 1 < lines.length) {
        const n = /^\s*name:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(lines[i + 1])
        if (n) name = n[1]
      }
      rows.push({ id: m[1], name })
    }
  } catch (e) { /* 无补丁文件 */ }
  return rows
}

/** 从 profile 补丁中移除指定 id 的激活行；若所在 insert 块清空则连带移除块头。 */
function removePatchRow(id) {
  const p = patchPath()
  if (!existsSync(p)) return true
  const lines = readFileSync(p, 'utf8').split(/\r?\n/)
  const re = new RegExp('^\\s*-\\s*id:\\s*' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$')
  let idx = -1
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) { idx = i; break }
  }
  if (idx < 0) return true
  lines.splice(idx, 1)
  if (idx < lines.length && /^\s*name:/.test(lines[idx])) lines.splice(idx, 1)
  // 清理空 insert 块
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*-\s*insert:\s*$/.test(lines[i])) continue
    let j = i + 1
    while (j < lines.length && lines[j].trim() === '') j++
    if (j >= lines.length || /^-\s/.test(lines[j]) || /^[#]/.test(lines[j]) || /^\S/.test(lines[j])) {
      // 后随另一个顶层条目/注释/结束 → 空块，移除
      lines.splice(i, 1)
      i--
    }
  }
  writeFileSync(p, lines.join('\n'), 'utf8')
  return true
}

function appendPatchRow(id, name) {
  const p = patchPath()
  let text = ''
  if (existsSync(p)) text = readFileSync(p, 'utf8')
  if (text && !/\n$/.test(text)) text += '\n'
  if (text && !/^\s*$/.test(text.slice(-2)) && text.length > 1 && text.slice(-1) !== '\n') text += '\n'
  text += '- insert:\n    - id: ' + id + "\n      name: '" + name + "'\n"
  writeFileSync(p, text, 'utf8')
}

/** 递归收集目录树中的 dsh 包（最深 4 层，跳过 node_modules/.git/隐藏目录）。 */
function collectDshPackages(root) {
  const found = []
  const walk = (dir, rel, depth) => {
    if (depth > 4 || found.length > 1) return
    let subs = []
    try {
      subs = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name[0] !== '.' && d.name !== 'node_modules')
    } catch (e) { return }
    for (const s of subs) {
      const childRel = rel ? rel + '/' + s.name : s.name
      const pp = join(dir, s.name, 'package.json')
      if (existsSync(pp)) {
        try {
          const pkg = JSON.parse(readFileSync(pp, 'utf8'))
          if (pkg && pkg.dsh && typeof pkg.name === 'string' && pkg.name) {
            found.push({
              dir: childRel,
              name: pkg.name,
              bundlePatch: !!(pkg.dsh.bundle && typeof pkg.dsh.bundle.patch === 'string'),
              prepare: typeof (pkg.scripts && pkg.scripts.prepare) === 'string',
            })
          }
        } catch (e) { /* 非 JSON */ }
      }
      if (found.length > 1) return
      walk(join(dir, s.name), childRel, depth + 1)
    }
  }
  walk(root, '', 0)
  return found
}

/** 仓库结构分类（安装与预检共用）：bundle / nested / preset / multi。 */
function classifyRepo(root) {
  const pkgPath = join(root, 'package.json')
  let type = 'preset'
  let pkgName = ''
  let nestedDir = ''
  let bundlePatch = false
  let prepare = false
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      if (pkg && pkg.dsh && typeof pkg.name === 'string' && pkg.name) {
        type = 'bundle'
        pkgName = pkg.name
        bundlePatch = !!(pkg.dsh.bundle && typeof pkg.dsh.bundle.patch === 'string')
        prepare = typeof (pkg.scripts && pkg.scripts.prepare) === 'string'
      }
    } catch (e) { type = 'preset' }
  }
  if (type === 'preset') {
    const candidates = collectDshPackages(root)
    if (candidates.length === 1) {
      type = 'nested'
      nestedDir = candidates[0].dir
      pkgName = candidates[0].name
      bundlePatch = candidates[0].bundlePatch
      prepare = candidates[0].prepare
    } else if (candidates.length > 1) {
      type = 'multi'
    }
  }
  const hasCordis = existsSync(join(root, 'cordis.yml'))
  return { type, pkgName, nestedDir, bundlePatch, prepare, hasCordis }
}

/** 安装后按包是否声明 dsh.bundle 决定激活方式；返回 {extraNote}。 */
function activateAfterAdd(pkgName, repoName) {
  const pkg = installedManifest(pkgName)
  if (declaresBundle(pkg)) {
    return '已自动加入 profile bundles（包声明 dsh.bundle.patch，重启后由补丁层自动激活）'
  }
  if (!readPatchRows().some((r) => r.id === repoName)) appendPatchRow(repoName, pkgName)
  return '已写 profile 激活行（该包未声明 dsh.bundle）'
}

/** 防御性删除 node_modules 中可能残留的包入口（pnpm 移除中断会留下失效符号链接）。 */
function removeNodeModulesEntry(pkgName) {
  const entry = join(profileDir(), 'node_modules', pkgName)
  try {
    const st = lstatSync(entry)
    if (st.isSymbolicLink() || st.isDirectory()) rmSync(entry, { recursive: true, force: true })
  } catch (e) { /* 不存在或不可读 → 无需处理 */ }
}

/**
 * 卸载后自动重启 dsh web：写一个临时 bat（先杀当前进程，再按原 argv 重启，
 * 并从用户注册表继承 API key）。运行中服务的热加载旧状态只会随进程消亡，
 * 重启后页面拿到不含已卸载行的新清单，避免 "bundle script failed to load"。
 * 返回是否成功调度。
 * 注意：延迟用 ping 而非 timeout（timeout 在 stdin 重定向时报错退出）；
 * 用 cmd /c <bat> 直启，不用 start ""（Node 传参会把空标题参数引号弄坏）。
 */
function scheduleRestart() {
  if (process.platform !== 'win32') return false
  const bin = process.argv[1]
  if (typeof bin !== 'string' || !bin) return false
  try {
    const q = (s) => '"' + String(s).replace(/"/g, '""') + '"'
    const args = process.argv.slice(2).map(q).join(' ')
    const lines = [
      'ping -n 4 127.0.0.1 >nul',
      'taskkill /F /PID ' + process.pid,
      'ping -n 3 127.0.0.1 >nul',
      'set "OPENCODE_API_KEY="',
      'for /f "tokens=2,*" %%a in (\'reg query "HKCU\\Environment" /v OPENCODE_API_KEY 2^>nul ^| findstr /i OPENCODE_API_KEY\') do set "OPENCODE_API_KEY=%%b"',
      'set "DEEPSEEK_API_KEY="',
      'for /f "tokens=2,*" %%a in (\'reg query "HKCU\\Environment" /v DEEPSEEK_API_KEY 2^>nul ^| findstr /i DEEPSEEK_API_KEY\') do set "DEEPSEEK_API_KEY=%%b"',
      'start "" /min ' + q(process.execPath) + ' ' + q(bin) + (args ? ' ' + args : ''),
      'del "%~f0"',
    ]
    const file = join(tmpdir(), 'dsh-workshop-restart-' + process.pid + '.bat')
    writeFileSync(file, lines.join('\r\n'), 'utf8')
    const child = spawn('cmd', ['/c', file], { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
    return true
  } catch (e) {
    return false
  }
}

/** 可选统计服务地址（未配置 = 完全禁用，零服务器模式不受影响）。 */
function statsUrl() {
  const v = process.env.DSH_WORKSHOP_STATS_URL
  return typeof v === 'string' && /^https?:\/\//.test(v) ? v.replace(/\/+$/, '') : null
}

/** 匿名安装 ID（每台机器一个随机值，存 profile 目录；不含任何身份信息）。 */
function statsId() {
  const file = join(profileDir(), '.workshop-stats-id')
  try {
    const existing = readFileSync(file, 'utf8').trim()
    if (/^[A-Za-z0-9-]{8,64}$/.test(existing)) return existing
  } catch (e) { /* 首次 */ }
  const id = randomUUID()
  try { writeFileSync(file, id, 'utf8') } catch (e) { /* 写失败则退化为一次性 id */ }
  return id
}

/** 上报安装/更新/卸载事件（尽力而为：2s 超时、吞掉一切错误、绝不阻塞主流程）。 */
function reportEvent(full, event) {
  const base = statsUrl()
  if (!base) return
  try {
    const payload = JSON.stringify({ full_name: full, event, install_id: statsId() })
    const url = new URL(base + '/events')
    const mod = url.protocol === 'https:' ? httpsRequest : httpRequest
    const req = mod(url, {
      method: 'POST',
      timeout: 2000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, () => {})
    req.on('error', () => {})
    req.on('timeout', () => req.destroy())
    req.end(payload)
  } catch (e) { /* 统计失败不影响安装 */ }
}

export function apply(ctx) {
  try {
    writeFileSync('C:/Users/Administrator/workshop-host-probe.txt', 'apply ran: ' + new Date().toISOString())
  } catch (e) { /* 探针失败不阻断 */ }
  const webServer = ctx.webServer

  const disposer = webServer.register({
    kind: 'prefix',
    path: API,
    handler: async (req, res) => {
      if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
      let url
      try { url = new URL(req.url, 'http://127.0.0.1') } catch (e) { return sendJson(res, 400, { ok: false, error: 'bad url' }) }
      const path = url.pathname
      try {
        if (path === API + '/status') {
          const dir = presetsDir()
          let list = []
          try {
            list = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
          } catch (e) { list = [] }
          return sendJson(res, 200, { ok: true, dir, list, git: gitAvailable(), rows: readPatchRows(), deps: profileDeps(), bundles: profileBundles(), installed: buildInstalled(), statsUrl: statsUrl() })
        }
        const full = String(url.searchParams.get('full_name') || '').trim()
        const htmlUrl = String(url.searchParams.get('html_url') || '').trim()
        const nameParam = String(url.searchParams.get('name') || '').trim()
        const repoParam = String(url.searchParams.get('repo') || '').trim()
        if (full && !/^[\w.-]+\/[\w.-]+$/.test(full)) return sendJson(res, 400, { ok: false, error: '仓库名不合法' })
        if (htmlUrl && htmlUrl.indexOf('https://github.com/') !== 0) return sendJson(res, 400, { ok: false, error: '仓库地址不合法' })
        if (nameParam && !/^[@\w][\w@./-]*$/.test(nameParam)) return sendJson(res, 400, { ok: false, error: '包名不合法' })
        if (repoParam && !/^[\w.-]+$/.test(repoParam)) return sendJson(res, 400, { ok: false, error: '仓库短名不合法' })
        if (!full && !nameParam && !repoParam) return sendJson(res, 400, { ok: false, error: '缺少 full_name/name/repo 参数' })
        const repoName = (full && full.split('/')[1]) || repoParam || null

        if (path === API + '/uninstall') {
          const rows = readPatchRows()
          const row = repoName ? rows.find((r) => r.id === repoName) : (nameParam ? rows.find((r) => r.name === nameParam || r.id === nameParam) : null)
          const depEntry = nameParam ? profileDeps().find((d) => d.name === nameParam) : null
          const specRepo = depEntry ? repoOfSpec(depEntry.spec) : null
          const parts = []
          let removedAny = false
          // 先移除 pnpm 依赖：失败则不做任何改动（不删激活行、不删本地副本），
          // 避免留下「package.json 仍指向已删目录」的失效符号链接。
          const depName = nameParam || (row && row.name) || (full ? findDepByRepo(full, repoName) : null)
          let depRemoved = false
          if (depName) {
            const rr = runCmd('cmd', ['/c', 'dsh', 'plugin', '--profile', 'web', 'remove', depName], 240000)
            if (rr.status !== 0) {
              return sendJson(res, 500, { ok: false, error: 'pnpm remove 失败，未做任何改动（插件文件保持可用）：' + String(rr.stderr || rr.stdout || '').slice(0, 300) + '。请检查后重试。' })
            }
            removeNodeModulesEntry(depName)
            parts.push('pnpm 依赖已移除')
            depRemoved = true
            removedAny = true
          }
          if (row) {
            removePatchRow(row.id)
            parts.push('激活行已移除')
            removedAny = true
          }
          // 本地副本目录名：full/repo 参数给的是仓库短名；name 参数下从 link spec 反推；
          // 激活行(id) 兜底。仅在确有来源时才删除，避免误删同名目录。
          const localRepo = repoName || (row ? row.id : null) || (specRepo && specRepo.fromLink ? specRepo.repo : null)
          const cloneDir = localRepo ? join(presetsDir(), localRepo) : null
          if (cloneDir && existsSync(cloneDir)) {
            rmSync(cloneDir, { recursive: true, force: true })
            parts.push('本地副本已删除')
            removedAny = true
          }
          if (!removedAny) return sendJson(res, 404, { ok: false, error: '未找到该插件的安装记录' })
          // 有依赖/激活行被移除时自动重启 dsh web：运行中服务的热加载旧状态
          // 随进程消亡，页面刷新后拿到不含该行的新清单，不再出现 bundle 加载失败。
          const restarted = depRemoved || !!row ? scheduleRestart() : false
          const tail = restarted ? '。dsh web 将在几秒后自动重启以刷新插件表（页面会自动恢复）' : '。需要重启 dsh web 后完全生效。'
          const reportFull = full || (specRepo && specRepo.full) || null
          if (reportFull) reportEvent(reportFull, 'uninstall')
          return sendJson(res, 200, { ok: true, removed: depRemoved ? 'bundle' : 'preset', note: parts.join('；') + tail })
        }

        if (!gitAvailable()) {
          return sendJson(res, 500, { ok: false, error: '本机未安装 git，一键安装不可用。请安装 Git for Windows 后重试（https://git-scm.com/download/win）。' })
        }

        // 安装前预检：克隆检测结构并给出可安装性评级（不执行安装；带 10 分钟缓存）
        if (path === API + '/probe') {
          if (!full) return sendJson(res, 400, { ok: false, error: '预检需要 full_name 参数' })
          if (!gitAvailable()) return sendJson(res, 200, { ok: true, verdict: 'unknown', type: null, pkgName: null, reasons: ['本机未安装 git，无法预检；一键安装不可用。'] })
          const now = Date.now()
          const cached = probeCache.get(full)
          if (cached && now - cached.at < 600000) return sendJson(res, 200, cached.result)
          const tmp = join(tmpdir(), 'dsh-workshop-probe-' + Date.now() + '-' + Math.floor(Math.random() * 100000))
          const cloneUrl = htmlUrl || ('https://github.com/' + full)
          const rc = runCmd('git', ['clone', '--depth', '1', cloneUrl, tmp], 120000)
          if (rc.status !== 0) {
            return sendJson(res, 200, { ok: true, verdict: 'unknown', type: null, pkgName: null, reasons: ['预检克隆失败：' + String(rc.stderr || rc.stdout || '').slice(0, 120)] })
          }
          const c = classifyRepo(tmp)
          rmSync(tmp, { recursive: true, force: true })
          const reasons = []
          let verdict = 'risky'
          if (c.type === 'multi') {
            verdict = 'manual'
            reasons.push('检测到多个 dsh 子包（monorepo 多包），无法自动选择安装目标——请按作者说明手动安装。')
          } else if (c.type === 'preset') {
            if (c.hasCordis) {
              verdict = 'installable'
              reasons.push('标准预设（含 cordis.yml）：将复制到 .agent-presets 安装。')
            } else {
              verdict = 'manual'
              reasons.push('仓库没有可识别的插件特征（根/子包无 dsh 声明、无 cordis.yml）——可能不是 DSH 插件；请按作者说明手动安装。')
            }
          } else {
            if (c.bundlePatch) reasons.push(c.type === 'bundle' ? '标准 bundle：已声明 dsh.bundle.patch，安装后自动激活。' : '嵌套包已声明 dsh.bundle.patch，安装后自动加入 profile bundles。')
            else reasons.push('未声明 dsh.bundle.patch：安装后将补写 profile 激活行（兼容旧包）。')
            if (c.prepare) reasons.push('带 prepare 构建脚本，pnpm 默认拦截，安装可能失败（需手动配置 allowBuilds）。')
            if (process.platform !== 'win32') reasons.push('本机非 Windows：自动安装依赖 cmd 通道，建议手动安装。')
            verdict = (c.bundlePatch && !c.prepare && process.platform === 'win32') ? 'installable' : 'risky'
          }
          const result = { ok: true, verdict, type: c.type === 'multi' ? null : c.type, pkgName: c.pkgName || null, reasons }
          probeCache.set(full, { at: now, result })
          return sendJson(res, 200, result)
        }

        if (path === API + '/install') {
          if (!full) return sendJson(res, 400, { ok: false, error: '安装需要 full_name 参数' })
          const rows = readPatchRows()
          if (rows.some((r) => r.id === repoName)) return sendJson(res, 200, { ok: true, already: true, type: 'bundle' })
          if (findDepByRepo(full, repoName)) return sendJson(res, 200, { ok: true, already: true, type: 'bundle' })
          const presetTarget = join(presetsDir(), repoName)
          if (existsSync(presetTarget)) return sendJson(res, 200, { ok: true, already: true, type: 'preset', path: presetTarget })
          // 临时克隆检测类型（与 /probe 共用 classifyRepo）
          const tmp = join(tmpdir(), 'dsh-workshop-' + Date.now() + '-' + Math.floor(Math.random() * 100000))
          const cloneUrl = htmlUrl || ('https://github.com/' + full)
          const rc = runCmd('git', ['clone', '--depth', '1', cloneUrl, tmp], 180000)
          if (rc.status !== 0) {
            return sendJson(res, 500, { ok: false, error: 'git clone 失败：' + String(rc.stderr || rc.stdout || '').slice(0, 400) })
          }
          const c = classifyRepo(tmp)
          const type = c.type
          let pkgName = c.pkgName
          let nestedDir = c.nestedDir
          if (type === 'multi') {
            rmSync(tmp, { recursive: true, force: true })
            return sendJson(res, 400, { ok: false, error: '检测到多个 dsh 子包，无法自动选择安装目标——请按插件页给出的安装方式手动安装。' })
          }
          if (type === 'nested') {
            const dir = presetsDir()
            try { mkdirSync(dir, { recursive: true }) } catch (e) {
              rmSync(tmp, { recursive: true, force: true })
              return sendJson(res, 500, { ok: false, error: '无法创建插件目录：' + dir })
            }
            const target = join(dir, repoName)
            if (existsSync(target)) rmSync(target, { recursive: true, force: true })
            try { cpSync(tmp, target, { recursive: true }) } catch (e) {
              rmSync(tmp, { recursive: true, force: true })
              rmSync(target, { recursive: true, force: true })
              return sendJson(res, 500, { ok: false, error: '复制失败：' + String((e && e.message) || e) })
            }
            rmSync(tmp, { recursive: true, force: true })
            const linkSpec = 'link:' + join(target, nestedDir)
            const ra = runCmd('cmd', ['/c', 'dsh', 'plugin', '--profile', 'web', 'add', linkSpec], 300000)
            if (ra.status !== 0) {
              const out = String(ra.stderr || ra.stdout || '')
              const hint = /allowBuilds|build scripts/i.test(out) ? '（该包带 prepare 构建脚本被 pnpm 拦截：按输出指引在 profile 的 pnpm-workspace.yaml 添加 allowBuilds 后重试）' : ''
              return sendJson(res, 500, { ok: false, error: 'dsh plugin add（link 子包）失败：' + out.slice(0, 300) + hint })
            }
            const actNote = activateAfterAdd(pkgName, repoName)
            reportEvent(full, 'install')
            return sendJson(res, 200, { ok: true, type: 'nested', pkgName, path: target, note: '已按嵌套包方式安装（link 到子包 ' + nestedDir + '）。' + actNote + '。需要重启 dsh web 后生效。' })
          }
          if (type === 'bundle') {
            rmSync(tmp, { recursive: true, force: true })
            const ra = runCmd('cmd', ['/c', 'dsh', 'plugin', '--profile', 'web', 'add', 'github:' + full], 300000)
            if (ra.status !== 0) {
              const out = String(ra.stderr || ra.stdout || '')
              const hint = /allowBuilds|build scripts/i.test(out) ? '（该包带 prepare 构建脚本被 pnpm 拦截：按输出指引在 profile 的 pnpm-workspace.yaml 添加 allowBuilds 后重试）' : ''
              return sendJson(res, 500, { ok: false, error: 'dsh plugin add 失败：' + out.slice(0, 300) + hint })
            }
            const actNote = activateAfterAdd(pkgName, repoName)
            reportEvent(full, 'install')
            return sendJson(res, 200, { ok: true, type: 'bundle', pkgName, note: '已按 bundle 方式安装（dsh plugin add）。' + actNote + '。需要重启 dsh web 后生效。' })
          }
          const dir = presetsDir()
          try { mkdirSync(dir, { recursive: true }) } catch (e) {
            return sendJson(res, 500, { ok: false, error: '无法创建插件目录：' + dir })
          }
          try { cpSync(tmp, presetTarget, { recursive: true }) } catch (e) {
            rmSync(tmp, { recursive: true, force: true })
            return sendJson(res, 500, { ok: false, error: '复制失败：' + String((e && e.message) || e) })
          }
          rmSync(tmp, { recursive: true, force: true })
          const hasCordis = existsSync(join(presetTarget, 'cordis.yml'))
          reportEvent(full, 'install')
          return sendJson(res, 200, {
            ok: true,
            type: 'preset',
            path: presetTarget,
            hasCordis,
            note: hasCordis ? null : '该仓库根目录没有 cordis.yml，可能不是标准插件预设，已按原样放入。',
          })
        }

        if (path === API + '/update') {
          const rows = readPatchRows()
          const row = repoName ? rows.find((r) => r.id === repoName) : (nameParam ? rows.find((r) => r.name === nameParam || r.id === nameParam) : null)
          const depEntry = nameParam ? profileDeps().find((d) => d.name === nameParam) : null
          const specRepo = depEntry ? repoOfSpec(depEntry.spec) : null
          const depName = nameParam || (row && row.name) || (full ? findDepByRepo(full, repoName) : null)
          // 本地副本目录名：full/repo 参数给的是仓库短名；name 参数下从 link spec 反推；
          // 激活行(id) 兜底。
          const localRepo = repoName || (row ? row.id : null) || (specRepo && specRepo.fromLink ? specRepo.repo : null)
          if (depName) {
            const cloneDir = localRepo ? join(presetsDir(), localRepo) : null
            if (cloneDir && existsSync(cloneDir)) {
              const rp = runCmd('git', ['-C', cloneDir, 'pull', '--ff-only'], 180000)
              if (rp.status !== 0) {
                return sendJson(res, 500, { ok: false, error: 'git pull 失败：' + String(rp.stderr || rp.stdout || '').slice(0, 400) })
              }
              const reportFull2 = full || (specRepo && specRepo.full) || null
              if (reportFull2) reportEvent(reportFull2, 'update')
              return sendJson(res, 200, { ok: true, note: '已拉取最新代码（link 安装），重启 dsh web 后生效。' })
            }
            const ru = runCmd('cmd', ['/c', 'dsh', 'plugin', '--profile', 'web', 'update', depName], 300000)
            if (ru.status !== 0) {
              return sendJson(res, 500, { ok: false, error: 'pnpm update 失败：' + String(ru.stderr || ru.stdout || '').slice(0, 400) })
            }
            const reportFull3 = full || (specRepo && specRepo.full) || null
            if (reportFull3) reportEvent(reportFull3, 'update')
            return sendJson(res, 200, { ok: true, note: '已更新依赖；需要重启 dsh web 后生效。' })
          }
          const target = localRepo ? join(presetsDir(), localRepo) : null
          if (!target || !existsSync(target)) return sendJson(res, 404, { ok: false, error: '尚未安装该插件' })
          const r = runCmd('git', ['-C', target, 'pull', '--ff-only'], 180000)
          if (r.status !== 0) {
            return sendJson(res, 500, { ok: false, error: 'git pull 失败：' + String(r.stderr || r.stdout || '').slice(0, 400) })
          }
          if (full) reportEvent(full, 'update')
          return sendJson(res, 200, { ok: true, note: '已拉取最新代码。' })
        }
        return sendJson(res, 404, { ok: false, error: 'unknown api' })
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: String((e && e.message) || e) })
      }
    },
  })

  ctx.on('dispose', () => disposer())
}
