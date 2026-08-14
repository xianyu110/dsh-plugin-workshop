/**
 * dsh-plugin-workshop（宿主侧）v1.3.0
 *
 * 智能一键安装/卸载：
 * - GET /dsh-plugin-workshop/api/status    → 插件目录、已安装列表、profile 依赖/激活行/bundles、git 探测
 * - GET /dsh-plugin-workshop/api/install   → 临时克隆检测类型：
 *     bundle 型（package.json 声明 dsh.*）→ dsh plugin add github:...；
 *       若包声明 dsh.bundle.patch，dsh 会自动把它加入 profile bundles（补丁层自动激活），
 *       否则补写 profile 激活行（与旧版插件兼容）。
 *     nested 型（恰好一个子目录是 dsh 包）→ 本地副本 + dsh plugin add link:<子目录>，同上判断激活方式
 *     preset 型（无 dsh 声明）            → 拷入 .agent-presets/<repo>
 * - GET /dsh-plugin-workshop/api/update    → bundle 型 pnpm update；nested/preset 型 git pull
 * - GET /dsh-plugin-workshop/api/uninstall → 按安装方式逆向清理（删激活行/出 bundles + pnpm remove / 删目录）
 *
 * 安全：
 * - 仅接受带自定义头 X-DSH-Workshop: 1 的请求（跨站请求无法带自定义头，
 *   且本服务不处理 CORS 预检，天然挡 CSRF）；
 * - full_name 严格校验 owner/repo 格式；clone 地址只允许 github.com。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

export const inject = ['webServer']

const API = '/dsh-plugin-workshop/api'

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

/** 按仓库 spec 反查依赖名：github:owner/repo、*.git、或 .agent-presets/<repo>/ 的 link 路径。 */
function findDepByRepo(full, repoName) {
  const specMatch = full.toLowerCase()
  for (const d of profileDeps()) {
    const spec = d.spec.toLowerCase()
    if (spec.indexOf('github:' + specMatch) >= 0) return d.name
    if (spec.indexOf('github.com/' + specMatch) >= 0) return d.name
    if (spec.indexOf(specMatch + '.git') >= 0) return d.name
    if (/link:|file:/.test(spec) && new RegExp('[\\\\/]\\.agent-presets[\\\\/]' + repoName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([\\\\/]|$)').test(spec)) return d.name
  }
  return null
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

/** 安装后按包是否声明 dsh.bundle 决定激活方式；返回 {extraNote}。 */
function activateAfterAdd(pkgName, repoName) {
  const pkg = installedManifest(pkgName)
  if (declaresBundle(pkg)) {
    return '已自动加入 profile bundles（包声明 dsh.bundle.patch，重启后由补丁层自动激活）'
  }
  if (!readPatchRows().some((r) => r.id === repoName)) appendPatchRow(repoName, pkgName)
  return '已写 profile 激活行（该包未声明 dsh.bundle）'
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
          return sendJson(res, 200, { ok: true, dir, list, git: gitAvailable(), rows: readPatchRows(), deps: profileDeps(), bundles: profileBundles() })
        }
        const full = String(url.searchParams.get('full_name') || '').trim()
        const htmlUrl = String(url.searchParams.get('html_url') || '').trim()
        if (!/^[\w.-]+\/[\w.-]+$/.test(full)) return sendJson(res, 400, { ok: false, error: '仓库名不合法' })
        if (htmlUrl && htmlUrl.indexOf('https://github.com/') !== 0) return sendJson(res, 400, { ok: false, error: '仓库地址不合法' })
        const repoName = full.split('/')[1]

        if (path === API + '/uninstall') {
          const rows = readPatchRows()
          const row = rows.find((r) => r.id === repoName)
          const parts = []
          let removedAny = false
          if (row) {
            removePatchRow(repoName)
            parts.push('激活行已移除')
            removedAny = true
          }
          const depName = (row && row.name) || findDepByRepo(full, repoName)
          if (depName) {
            const rr = runCmd('cmd', ['/c', 'dsh', 'plugin', '--profile', 'web', 'remove', depName], 240000)
            if (rr.status !== 0) parts.push('pnpm remove 失败：' + String(rr.stderr || rr.stdout || '').slice(0, 200))
            else parts.push('pnpm 依赖已移除' + (profileBundles().indexOf(depName) >= 0 ? '（仍残留于 bundles，重启后自动清理）' : ''))
            removedAny = true
          }
          const cloneDir = join(presetsDir(), repoName)
          if (existsSync(cloneDir)) {
            rmSync(cloneDir, { recursive: true, force: true })
            parts.push('本地副本已删除')
            removedAny = true
          }
          if (!removedAny) return sendJson(res, 404, { ok: false, error: '未找到该插件的安装记录' })
          return sendJson(res, 200, { ok: true, removed: 'bundle', note: parts.join('；') + '。需要重启 dsh web 后完全生效。' })
        }

        if (!gitAvailable()) {
          return sendJson(res, 500, { ok: false, error: '本机未安装 git，一键安装不可用。请安装 Git for Windows 后重试（https://git-scm.com/download/win）。' })
        }

        if (path === API + '/install') {
          const rows = readPatchRows()
          if (rows.some((r) => r.id === repoName)) return sendJson(res, 200, { ok: true, already: true, type: 'bundle' })
          if (findDepByRepo(full, repoName)) return sendJson(res, 200, { ok: true, already: true, type: 'bundle' })
          const presetTarget = join(presetsDir(), repoName)
          if (existsSync(presetTarget)) return sendJson(res, 200, { ok: true, already: true, type: 'preset', path: presetTarget })
          // 临时克隆检测类型
          const tmp = join(tmpdir(), 'dsh-workshop-' + Date.now() + '-' + Math.floor(Math.random() * 100000))
          const cloneUrl = htmlUrl || ('https://github.com/' + full)
          const rc = runCmd('git', ['clone', '--depth', '1', cloneUrl, tmp], 180000)
          if (rc.status !== 0) {
            return sendJson(res, 500, { ok: false, error: 'git clone 失败：' + String(rc.stderr || rc.stdout || '').slice(0, 400) })
          }
          let type = 'preset'
          let pkgName = ''
          let nestedDir = ''
          const pkgPath = join(tmp, 'package.json')
          if (existsSync(pkgPath)) {
            try {
              const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
              if (pkg && pkg.dsh && typeof pkg.name === 'string' && pkg.name) {
                type = 'bundle'
                pkgName = pkg.name
              }
            } catch (e) { type = 'preset' }
          }
          if (type === 'preset') {
            // 嵌套包检测：根目录无 dsh 声明，但恰好一个子目录是 dsh 包（皮肤合集等 monorepo 布局）
            try {
              const subs = readdirSync(tmp, { withFileTypes: true }).filter((d) => d.isDirectory())
              const candidates = []
              for (const s of subs) {
                const pp = join(tmp, s.name, 'package.json')
                if (!existsSync(pp)) continue
                try {
                  const pkg = JSON.parse(readFileSync(pp, 'utf8'))
                  if (pkg && pkg.dsh && typeof pkg.name === 'string' && pkg.name) candidates.push({ dir: s.name, name: pkg.name })
                } catch (e) { /* 非 JSON */ }
              }
              if (candidates.length === 1) {
                type = 'nested'
                nestedDir = candidates[0].dir
                pkgName = candidates[0].name
              }
            } catch (e) { /* 保留 preset */ }
          }
          if (type === 'nested') {
            const dir = presetsDir()
            try { mkdirSync(dir, { recursive: true }) } catch (e) {
              return sendJson(res, 500, { ok: false, error: '无法创建插件目录：' + dir })
            }
            const target = join(dir, repoName)
            if (existsSync(target)) rmSync(target, { recursive: true, force: true })
            cpSync(tmp, target, { recursive: true })
            rmSync(tmp, { recursive: true, force: true })
            const linkSpec = 'link:' + join(target, nestedDir)
            const ra = runCmd('cmd', ['/c', 'dsh', 'plugin', '--profile', 'web', 'add', linkSpec], 300000)
            if (ra.status !== 0) {
              return sendJson(res, 500, { ok: false, error: 'dsh plugin add（link 子包）失败：' + String(ra.stderr || ra.stdout || '').slice(0, 400) })
            }
            const actNote = activateAfterAdd(pkgName, repoName)
            return sendJson(res, 200, { ok: true, type: 'nested', pkgName, path: target, note: '已按嵌套包方式安装（link 到子包 ' + nestedDir + '）。' + actNote + '。需要重启 dsh web 后生效。' })
          }
          if (type === 'bundle') {
            rmSync(tmp, { recursive: true, force: true })
            const ra = runCmd('cmd', ['/c', 'dsh', 'plugin', '--profile', 'web', 'add', 'github:' + full], 300000)
            if (ra.status !== 0) {
              return sendJson(res, 500, { ok: false, error: 'dsh plugin add 失败：' + String(ra.stderr || ra.stdout || '').slice(0, 400) })
            }
            const actNote = activateAfterAdd(pkgName, repoName)
            return sendJson(res, 200, { ok: true, type: 'bundle', pkgName, note: '已按 bundle 方式安装（dsh plugin add）。' + actNote + '。需要重启 dsh web 后生效。' })
          }
          const dir = presetsDir()
          try { mkdirSync(dir, { recursive: true }) } catch (e) {
            return sendJson(res, 500, { ok: false, error: '无法创建插件目录：' + dir })
          }
          try { cpSync(tmp, presetTarget, { recursive: true }) } catch (e) {
            return sendJson(res, 500, { ok: false, error: '复制失败：' + String((e && e.message) || e) })
          }
          rmSync(tmp, { recursive: true, force: true })
          const hasCordis = existsSync(join(presetTarget, 'cordis.yml'))
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
          const row = rows.find((r) => r.id === repoName)
          const depName = (row && row.name) || findDepByRepo(full, repoName)
          if (depName) {
            const cloneDir = join(presetsDir(), repoName)
            if (existsSync(cloneDir)) {
              const rp = runCmd('git', ['-C', cloneDir, 'pull', '--ff-only'], 180000)
              if (rp.status !== 0) {
                return sendJson(res, 500, { ok: false, error: 'git pull 失败：' + String(rp.stderr || rp.stdout || '').slice(0, 400) })
              }
              return sendJson(res, 200, { ok: true, note: '已拉取最新代码（link 安装），重启 dsh web 后生效。' })
            }
            const ru = runCmd('cmd', ['/c', 'dsh', 'plugin', '--profile', 'web', 'update', depName], 300000)
            if (ru.status !== 0) {
              return sendJson(res, 500, { ok: false, error: 'pnpm update 失败：' + String(ru.stderr || ru.stdout || '').slice(0, 400) })
            }
            return sendJson(res, 200, { ok: true, note: '已更新依赖；需要重启 dsh web 后生效。' })
          }
          const target = join(presetsDir(), repoName)
          if (!existsSync(target)) return sendJson(res, 404, { ok: false, error: '尚未安装该插件' })
          const r = runCmd('git', ['-C', target, 'pull', '--ff-only'], 180000)
          if (r.status !== 0) {
            return sendJson(res, 500, { ok: false, error: 'git pull 失败：' + String(r.stderr || r.stdout || '').slice(0, 400) })
          }
          return sendJson(res, 200, { ok: true })
        }
        return sendJson(res, 404, { ok: false, error: 'unknown api' })
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: String((e && e.message) || e) })
      }
    },
  })

  ctx.on('dispose', () => disposer())
}
