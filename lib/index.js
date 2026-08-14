/**
 * dsh-plugin-workshop（宿主侧）v1.1.0
 *
 * 为浏览器端工坊提供一键安装能力：通过 webServer 服务注册同源 HTTP 接口。
 * - GET /dsh-plugin-workshop/api/status   → 插件目录、已安装列表、git 可用性探测
 * - GET /dsh-plugin-workshop/api/install  → git clone --depth 1 到 .agent-presets/
 * - GET /dsh-plugin-workshop/api/update   → git -C <dir> pull --ff-only
 *
 * 安全：
 * - 仅接受带自定义头 X-DSH-Workshop: 1 的请求（跨站请求无法带自定义头，
 *   且本服务不处理 CORS 预检，天然挡 CSRF）；
 * - full_name 严格校验 owner/repo 格式；clone 地址只允许 github.com；
 * - 所有操作只落在 DSH_HOME/.agent-presets 下。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const API = '/dsh-plugin-workshop/api'

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body)
}

function presetsDir() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), '.agent-presets')
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

export function apply(ctx) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return

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
          return sendJson(res, 200, { ok: true, dir, list, git: gitAvailable() })
        }
        if (path === API + '/install' || path === API + '/update') {
          const full = String(url.searchParams.get('full_name') || '').trim()
          const htmlUrl = String(url.searchParams.get('html_url') || '').trim()
          if (!/^[\w.-]+\/[\w.-]+$/.test(full)) return sendJson(res, 400, { ok: false, error: '仓库名不合法' })
          if (htmlUrl && htmlUrl.indexOf('https://github.com/') !== 0) return sendJson(res, 400, { ok: false, error: '仓库地址不合法' })
          if (!gitAvailable()) {
            return sendJson(res, 500, { ok: false, error: '本机未安装 git，一键安装不可用。请安装 Git for Windows 后重试（https://git-scm.com/download/win）。' })
          }
          const repoName = full.split('/')[1]
          const dir = presetsDir()
          try { mkdirSync(dir, { recursive: true }) } catch (e) {
            return sendJson(res, 500, { ok: false, error: '无法创建插件目录：' + dir })
          }
          const target = join(dir, repoName)
          if (path === API + '/install') {
            if (existsSync(target)) return sendJson(res, 200, { ok: true, already: true, path: target })
            const cloneUrl = htmlUrl || ('https://github.com/' + full)
            const r = spawnSync('git', ['clone', '--depth', '1', cloneUrl, target], { encoding: 'utf8', timeout: 120000, windowsHide: true })
            if (r.status !== 0) {
              return sendJson(res, 500, { ok: false, error: 'git clone 失败：' + String(r.stderr || r.stdout || '').slice(0, 400) })
            }
            const hasCordis = existsSync(join(target, 'cordis.yml'))
            return sendJson(res, 200, {
              ok: true,
              path: target,
              hasCordis,
              note: hasCordis ? null : '该仓库根目录没有 cordis.yml，可能不是标准插件预设，已按原样放入。',
            })
          }
          // update
          if (!existsSync(target)) return sendJson(res, 404, { ok: false, error: '尚未安装该插件' })
          const r = spawnSync('git', ['-C', target, 'pull', '--ff-only'], { encoding: 'utf8', timeout: 120000, windowsHide: true })
          if (r.status !== 0) {
            return sendJson(res, 500, { ok: false, error: 'git pull 失败：' + String(r.stderr || r.stdout || '').slice(0, 400) })
          }
          return sendJson(res, 200, { ok: true, path: target })
        }
        return sendJson(res, 404, { ok: false, error: 'unknown api' })
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: String((e && e.message) || e) })
      }
    },
  })

  ctx.on('dispose', () => disposer())
}
