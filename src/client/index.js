/**
 * dsh-plugin-workshop（浏览器端源码）v1.0.0
 *
 * 常驻版插件工坊：
 * - 侧栏「新会话」按钮正下方克隆一个同规格「插件工坊」按钮（DOM 克隆官方按钮，
 *   样式/大小与官方完全一致，MutationObserver 保证重建后自动恢复）；
 * - shell.overlay 浮层 + 设置→插件 标签页承载工坊界面（React）；
 * - 默认只搜 DSH 插件话题（topic:dsh-plugin），空结果提供「去全站搜索」；
 * - 时间窗口飙升榜：近 7/30/90 天新建 + 按热度排序（Steam Trending 近似）；
 * - 数据全部走浏览器 fetch：GitHub 搜索 API（CORS 直连），
 *   插件特征验证走 raw.githubusercontent.com（不消耗 API 额度）；
 * - 中文关键词映射、描述/README 机翻（Google gtx）；
 * - 匿名额度 10 次/分（带剩余/恢复显示），可选 Token 30 次/分。
 */
const TAG = '[wkshp]'

let React = null
try { React = require('react') } catch (e) { React = null }

// ---------------- 共享开关 store（DOM 按钮与 React 浮层共用） ----------------
let isOpen = false
const openListeners = new Set()
const store = {
  isOpen: function () { return isOpen },
  open: function () { isOpen = true; openListeners.forEach(function (l) { l() }) },
  close: function () { isOpen = false; openListeners.forEach(function (l) { l() }) },
  subscribe: function (l) { openListeners.add(l); return function () { openListeners.delete(l) } },
}

// ---------------- Token（localStorage） ----------------
const TOKEN_KEY = 'dsh-plugin-workshop:token'
function getToken() { try { return window.localStorage.getItem(TOKEN_KEY) || '' } catch (e) { return '' } }
function saveToken(v) { try { if (v) window.localStorage.setItem(TOKEN_KEY, v); else window.localStorage.removeItem(TOKEN_KEY) } catch (e) {} }

// ---------------- 网络 ----------------
async function ghFetch(url) {
  const headers = {}
  const t = getToken()
  if (t) headers['Authorization'] = 'Bearer ' + t
  const res = await window.fetch(url, { headers: headers })
  let data = null
  try { data = await res.json() } catch (e) { data = null }
  const remain = res.headers.get('x-ratelimit-remaining')
  const reset = res.headers.get('x-ratelimit-reset')
  return { status: res.status, data: data, remaining: remain === null ? null : Number(remain), reset: reset === null ? null : Number(reset) }
}

async function rawFetch(url) {
  try {
    const r = await window.fetch(url, { signal: AbortSignal.timeout(10000) })
    if (r.status === 200) return await r.text()
  } catch (e) {}
  return null
}

const TOPIC_Q = 'topic:dsh-plugin'
const WHEN_DAYS = { '7d': 7, '30d': 30, '90d': 90 }
const WHEN_LABEL = { '7d': '近7天飙升', '30d': '近30天飙升', '90d': '近90天飙升' }
function windowDate(days) {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
}

const GLOSSARY = [
  ['计算器', 'calculator'], ['定时器', 'timer'], ['数据库', 'database'],
  ['浏览器', 'browser'], ['编辑器', 'editor'], ['词典', 'dictionary'],
  ['字典', 'dictionary'], ['翻译', 'translate'], ['天气', 'weather'],
  ['截图', 'screenshot'], ['扩展', 'extension'], ['插件', 'plugin'],
  ['笔记', 'note'], ['邮件', 'email'], ['邮箱', 'email'],
  ['日历', 'calendar'], ['待办', 'todo'], ['任务', 'task'],
  ['图片', 'image'], ['图像', 'image'], ['视频', 'video'],
  ['音乐', 'music'], ['终端', 'terminal'], ['文件', 'file'],
  ['搜索', 'search'], ['下载', 'download'], ['上传', 'upload'],
  ['代理', 'proxy'], ['代码', 'code'], ['聊天', 'chat'],
  ['语音', 'voice'], ['阅读', 'reader'], ['写作', 'writing'],
  ['工具', 'tool'], ['主题', 'theme'], ['皮肤', 'skin'],
  ['图标', 'icon'], ['通知', 'notification'], ['密码', 'password'],
  ['安全', 'security'], ['数学', 'math'], ['科学', 'science'],
  ['时钟', 'clock'], ['表格', 'table'], ['图表', 'chart'],
]
function hasCJK(s) { return /[\u4e00-\u9fff]/.test(s) }
function hasLatin(s) { return /[A-Za-z0-9]/.test(s) }
function mapZh(s) {
  let out = ' ' + s + ' '
  for (let i = 0; i < GLOSSARY.length; i++) out = out.split(GLOSSARY[i][0]).join(' ' + GLOSSARY[i][1] + ' ')
  return out.replace(/\s+/g, ' ').trim()
}

function pickRepo(r) {
  if (!r || typeof r !== 'object') return null
  return {
    full_name: typeof r.full_name === 'string' ? r.full_name : '',
    html_url: typeof r.html_url === 'string' ? r.html_url : '',
    description: typeof r.description === 'string' ? r.description : '',
    stars: Number(r.stargazers_count) || 0,
    forks: Number(r.forks_count) || 0,
    language: typeof r.language === 'string' ? r.language : null,
    pushed_at: typeof r.pushed_at === 'string' ? r.pushed_at : null,
    created_at: typeof r.created_at === 'string' ? r.created_at : null,
    topics: Array.isArray(r.topics) ? r.topics.map(String).slice(0, 8) : [],
    owner: r.owner && typeof r.owner.login === 'string' ? r.owner.login : '',
    avatar: r.owner && typeof r.owner.avatar_url === 'string' ? r.owner.avatar_url : '',
    license: r.license && typeof r.license.spdx_id === 'string' ? r.license.spdx_id : null,
    archived: !!r.archived,
    fork: !!r.fork,
  }
}

async function searchCatalog(q, sort, page) {
  const url = 'https://api.github.com/search/repositories?q=' + encodeURIComponent(q) + '&sort=' + sort + '&order=desc&per_page=24&page=' + page
  const got = await ghFetch(url)
  if (got.status === 403 && got.data && got.data.message && /rate/i.test(String(got.data.message))) {
    const err = new Error('搜索额度已用尽（匿名 10 次/分）。稍候自动恢复，或在 ⚙ 里填入 GitHub Token（30 次/分）。')
    err.rate = true
    err.reset = got.reset
    throw err
  }
  if (got.status === 401) {
    const err = new Error('GitHub Token 无效，已忽略该 Token。')
    err.tokenBad = true
    throw err
  }
  if (got.status === 422) {
    const msg = (got.data && Array.isArray(got.data.errors) && got.data.errors.length && got.data.errors[0].message) ? got.data.errors[0].message : '查询语法不合法'
    throw new Error('查询错误 (422)：' + msg)
  }
  if (got.status !== 200) {
    const msg = got.data && typeof got.data.message === 'string' ? got.data.message : ''
    throw new Error('GitHub 返回 ' + got.status + (msg ? '：' + msg : ''))
  }
  const items = (got.data.items || []).map(pickRepo).filter(Boolean)
  return { items: items, total: Number(got.data.total_count) || 0, remaining: got.remaining, reset: got.reset }
}

// ---------------- 插件特征验证（raw CDN，不占 API 额度） ----------------
const verifyCache = new Map()
async function verifyRepo(full) {
  if (verifyCache.has(full)) return verifyCache.get(full)
  let out = 'no'
  const pkg = await rawFetch('https://raw.githubusercontent.com/' + full + '/HEAD/package.json')
  if (pkg !== null) {
    try {
      const j = JSON.parse(pkg)
      if (j && (j.dsh || (typeof j.name === 'string' && /^dsh-/.test(j.name)))) out = 'yes'
    } catch (e) { out = 'no' }
  } else {
    const cands = ['cordis.yml', 'cordis.patch.yml', 'agent.md', 'AGENT.md']
    for (let i = 0; i < cands.length; i++) {
      const t = await rawFetch('https://raw.githubusercontent.com/' + full + '/HEAD/' + cands[i])
      if (t !== null) { out = 'yes'; break }
    }
  }
  verifyCache.set(full, out)
  return out
}

// ---------------- 机翻 ----------------
const transCache = new Map()
async function gtxBatch(texts) {
  const out = {}
  const todo = []
  texts.forEach(function (t) {
    if (!t) return
    if (transCache.has(t)) { out[t] = transCache.get(t); return }
    todo.push(t)
  })
  for (let i = 0; i < todo.length; i += 8) {
    const batch = todo.slice(i, i + 8)
    const results = await Promise.all(batch.map(function (t) {
      return window.fetch('https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=' + encodeURIComponent(t), { signal: AbortSignal.timeout(15000) })
        .then(function (r) { return r.json() })
        .then(function (j) {
          let s = ''
          if (Array.isArray(j[0])) s = j[0].map(function (x) { return x && x[0] ? x[0] : '' }).join('')
          return [t, s]
        })
        .catch(function () { return [t, ''] })
    }))
    results.forEach(function (p) {
      if (p[1]) { transCache.set(p[0], p[1]); out[p[0]] = p[1] }
    })
  }
  if (transCache.size > 3000) transCache.clear()
  return out
}

const readmeZhCache = new Map()
async function translateReadme(full, text) {
  if (readmeZhCache.has(full)) return readmeZhCache.get(full)
  const chunks = []
  const lines = text.split(/\r?\n/)
  let buf = ''
  for (let i = 0; i < lines.length && chunks.length < 8; i++) {
    const line = lines[i]
    if ((buf + '\n' + line).length > 900 && buf) { chunks.push(buf); buf = line }
    else buf = buf ? buf + '\n' + line : line
  }
  if (buf && chunks.length < 8) chunks.push(buf)
  const map = await gtxBatch(chunks)
  const zh = chunks.map(function (c) { return map[c] || c }).join('\n')
  readmeZhCache.set(full, zh)
  if (readmeZhCache.size > 100) readmeZhCache.clear()
  return zh
}

// ---------------- 侧栏按钮（DOM 克隆官方「新会话」按钮） ----------------
let obs = null
let installTimer = 0
function findNewSessionButton() {
  if (typeof document === 'undefined') return null
  const nodes = document.querySelectorAll('button[class*="newSession"]')
  for (let i = 0; i < nodes.length; i++) {
    if (String(nodes[i].className).indexOf('newSessionLabel') === -1) return nodes[i]
  }
  return null
}
function installSidebarButton() {
  if (typeof document === 'undefined') return
  const target = findNewSessionButton()
  if (!target || !target.parentElement) return
  if (target.parentElement.querySelector('.dsws-sidebar-entry')) return
  const btn = target.cloneNode(true)
  btn.className = String(target.className) + ' dsws-sidebar-entry'
  btn.setAttribute('aria-label', '插件工坊')
  btn.innerHTML = ''
  const icon = document.createElement('span')
  icon.className = 'dsws-sidebar-icon'
  icon.textContent = '\uD83E\uDDE9'
  btn.appendChild(icon)
  const label = document.createElement('span')
  label.className = 'dsws-sidebar-label'
  label.textContent = '插件工坊'
  btn.appendChild(label)
  btn.addEventListener('click', function (ev) {
    ev.preventDefault()
    ev.stopPropagation()
    store.open()
  })
  target.insertAdjacentElement('afterend', btn)
  console.log(TAG, '侧栏按钮已安装')
}
function watchSidebar() {
  if (typeof document === 'undefined' || obs) return
  obs = new MutationObserver(function () {
    window.clearTimeout(installTimer)
    installTimer = window.setTimeout(installSidebarButton, 300)
  })
  obs.observe(document.body, { childList: true, subtree: true })
}
function removeSidebarButton() {
  if (typeof document === 'undefined') return
  const nodes = document.querySelectorAll('.dsws-sidebar-entry')
  for (let i = 0; i < nodes.length; i++) nodes[i].remove()
}

// ---------------- React 界面 ----------------
if (React !== null) {
  function el(type, props) {
    const children = Array.prototype.slice.call(arguments, 2)
    return React.createElement.apply(null, [type, props].concat(children))
  }
  function timeAgo(iso) {
    if (!iso) return ''
    const t = Date.parse(iso)
    if (!isFinite(t)) return ''
    const diff = Date.now() - t
    const m = Math.floor(diff / 60000)
    if (m < 1) return '刚刚'
    if (m < 60) return m + ' 分钟前'
    const h = Math.floor(m / 60)
    if (h < 24) return h + ' 小时前'
    const d = Math.floor(h / 24)
    if (d < 30) return d + ' 天前'
    const mo = Math.floor(d / 30)
    if (mo < 12) return mo + ' 个月前'
    return Math.floor(mo / 12) + ' 年前'
  }
  function num(n) {
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
    return String(n)
  }
  function boldSeg(s) {
    const parts = String(s).split(/\*\*([^*]+)\*\*/)
    return parts.map(function (p, i) {
      if (p === '') return null
      return i % 2 === 1 ? el('strong', { key: 'b' + i }, p) : p
    }).filter(Boolean)
  }
  function linksBold(t) {
    const out = []
    let last = 0
    let seg = ''
    const re = /\[([^\]]+)\]\(([^)\s]+)\)/g
    let m
    while ((m = re.exec(t)) !== null) {
      if (m.index > last) seg += t.slice(last, m.index)
      if (seg) { out.push.apply(out, boldSeg(seg)); seg = '' }
      out.push(el('a', { className: 'dshws-a', href: m[2], target: '_blank', rel: 'noreferrer', key: 'a' + out.length }, m[1]))
      last = m.index + m[0].length
    }
    if (last < t.length) seg += t.slice(last)
    if (seg) out.push.apply(out, boldSeg(seg))
    return out
  }
  function inline(s) {
    const parts = []
    let rest = String(s)
    while (true) {
      const i = rest.indexOf('`')
      if (i < 0) break
      const j = rest.indexOf('`', i + 1)
      if (j < 0) break
      if (i > 0) parts.push(rest.slice(0, i))
      parts.push(el('code', { className: 'dshws-inline-code', key: 'ic' + parts.length }, rest.slice(i + 1, j)))
      rest = rest.slice(j + 1)
    }
    if (rest) parts.push(rest)
    const out = []
    parts.forEach(function (p) {
      if (p === null || p === undefined || p === '') return
      if (typeof p !== 'string') { out.push(p); return }
      out.push.apply(out, linksBold(p))
    })
    return out
  }
  function mdLite(text) {
    const nodes = []
    const lines = String(text || '').split(/\r?\n/)
    let inCode = false
    let codeBuf = []
    let listBuf = []
    let inList = false
    function flushCode() {
      if (codeBuf.length) nodes.push(el('pre', { className: 'dshws-code', key: 'c' + nodes.length }, codeBuf.join('\n')))
      codeBuf = []
      inCode = false
    }
    function flushList() {
      if (listBuf.length) nodes.push(el('ul', { className: 'dshws-ul', key: 'l' + nodes.length }, listBuf))
      listBuf = []
      inList = false
    }
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]
      const line = raw.replace(/\s+$/, '')
      if (/^\s*```/.test(line)) {
        if (inCode) { flushCode() } else { flushList(); inCode = true }
        continue
      }
      if (inCode) { codeBuf.push(raw); continue }
      if (/^\s*$/.test(line)) { flushList(); continue }
      let m = /^(#{1,4})\s+(.*)$/.exec(line)
      if (m) {
        flushList()
        const level = Math.min(3, m[1].length)
        nodes.push(el('div', { className: 'dshws-h dshws-h' + level, key: 'h' + nodes.length }, inline(m[2])))
        continue
      }
      m = /^[-*]\s+(.*)$/.exec(line)
      if (m) { inList = true; listBuf.push(el('li', { key: 'i' + listBuf.length }, inline(m[1]))); continue }
      flushList()
      nodes.push(el('div', { className: 'dshws-p', key: 'p' + nodes.length }, inline(line)))
    }
    flushCode()
    flushList()
    return nodes.length ? nodes : el('div', { className: 'dshws-p' }, '（无内容）')
  }

  function RepoCard(props) {
    const r = props.repo
    const v = props.verify
    return el('div', { className: 'dshws-card', onClick: props.onOpen },
      el('img', { className: 'dshws-avatar', src: r.avatar, alt: '' }),
      el('div', { className: 'dshws-card-body' },
        el('div', { className: 'dshws-card-title', title: r.full_name }, r.full_name),
        el('div', { className: 'dshws-card-desc' }, props.desc),
        el('div', { className: 'dshws-card-meta' },
          el('span', { className: 'dshws-pill' }, '\u2605 ' + num(r.stars)),
          v === 'yes' ? el('span', { className: 'dshws-pill dshws-badge-installed' }, '\u2713 疑似 DSH 插件') : null,
          v === 'no' ? el('span', { className: 'dshws-pill dshws-muted' }, '未检出插件特征') : null,
          r.language ? el('span', { className: 'dshws-pill' }, r.language) : null,
          r.pushed_at ? el('span', { className: 'dshws-pill dshws-muted' }, '更新于 ' + timeAgo(r.pushed_at)) : null,
          r.license ? el('span', { className: 'dshws-pill dshws-muted' }, r.license) : null,
        ),
      ),
    )
  }

  function DetailView(props) {
    const d = props.detail
    const back = el('button', { className: 'dshws-back', onClick: props.onBack }, '\u2190 返回')
    const [zhR, setZhR] = React.useState(null)
    const [busyR, setBusyR] = React.useState(false)
    const [viewR, setViewR] = React.useState('orig')
    if (d.loading) return el('div', { className: 'dshws-body dshws-detail' }, back, el('div', { className: 'dshws-status' }, '加载详情\u2026'))
    if (d.error) return el('div', { className: 'dshws-body dshws-detail' }, back, el('div', { className: 'dshws-error' }, '\u26a0 ' + d.error))
    const m = d.data
    const repoName = String(m.full_name || '').split('/').pop() || 'plugin'
    const cmd = 'git clone --depth 1 ' + m.html_url + '  \u201c<DSH_HOME>/.agent-presets/' + repoName + '\u201d'
    function doZhReadme() {
      setBusyR(true)
      translateReadme(m.full_name, m.readme || '').then(function (zh) {
        setZhR(zh || null)
        setBusyR(false)
        if (zh) setViewR('zh')
      }).catch(function () { setBusyR(false) })
    }
    const readmeToggle = zhR
      ? el('span', null,
          el('button', { className: 'dshws-mini' + (viewR === 'orig' ? ' dshws-mini-on' : ''), onClick: function () { setViewR('orig') } }, '原文'),
          el('button', { className: 'dshws-mini' + (viewR === 'zh' ? ' dshws-mini-on' : ''), onClick: function () { setViewR('zh') } }, '中文'),
        )
      : (busyR
          ? el('span', { className: 'dshws-pill dshws-muted' }, '翻译中\u2026')
          : (m.readme ? el('button', { className: 'dshws-mini', onClick: doZhReadme }, '翻译 README（机翻）') : null))
    const readmeText = zhR && viewR === 'zh' ? zhR : m.readme
    return el('div', { className: 'dshws-body dshws-detail' },
      back,
      el('div', { className: 'dshws-detail-head' },
        el('div', { className: 'dshws-detail-title' },
          m.avatar ? el('img', { className: 'dshws-avatar dshws-avatar-lg', src: m.avatar, alt: '' }) : null,
          el('span', null, m.full_name),
          el('a', { className: 'dshws-link', href: m.html_url, target: '_blank', rel: 'noreferrer' }, '在 GitHub 打开 \u2197'),
        ),
        el('div', { className: 'dshws-card-desc' }, props.desc),
        el('div', { className: 'dshws-card-meta' },
          el('span', { className: 'dshws-pill' }, '\u2605 ' + num(m.stars)),
          el('span', { className: 'dshws-pill' }, '\u2387 ' + num(m.forks)),
          m.language ? el('span', { className: 'dshws-pill' }, m.language) : null,
          m.license ? el('span', { className: 'dshws-pill' }, m.license) : null,
          m.pushed_at ? el('span', { className: 'dshws-pill dshws-muted' }, '更新于 ' + timeAgo(m.pushed_at)) : null,
          m.created_at ? el('span', { className: 'dshws-pill dshws-muted' }, '创建于 ' + timeAgo(m.created_at)) : null,
        ),
        m.topics.length ? el('div', { className: 'dshws-card-meta' }, m.topics.map(function (t) {
          return el('span', { className: 'dshws-pill dshws-muted', key: t }, '#' + t)
        })) : null,
      ),
      el('div', { className: 'dshws-section' },
        el('div', { className: 'dshws-section-label' }, '安装命令（浏览器版无法直接执行 git，请复制运行）'),
        el('pre', { className: 'dshws-install' }, cmd),
        el('div', { className: 'dshws-card-desc', style: { marginTop: 6 } }, 'DSH_HOME 默认为 ~/.dsh（Windows: %USERPROFILE%\\.dsh）。'),
      ),
      el('div', { className: 'dshws-section' },
        el('div', { className: 'dshws-section-label', style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
          el('span', null, 'README' + (m.readmeTruncated ? '（截断）' : '')),
          readmeToggle,
        ),
        el('div', { className: 'dshws-md' }, readmeText === null ? el('div', { className: 'dshws-p' }, '（无法获取 README）') : mdLite(readmeText)),
      ),
    )
  }

  function useOpen() {
    const [snap, setSnap] = React.useState(store.isOpen())
    React.useEffect(function () {
      return store.subscribe(function () { setSnap(store.isOpen()) })
    }, [])
    return snap
  }

  function Workshop(props) {
    const variant = props.variant
    const open = variant === 'overlay' ? useOpen() : true
    const [query, setQuery] = React.useState('')
    const [sort, setSort] = React.useState('stars')
    const [scope, setScope] = React.useState('topic')
    const [when, setWhen] = React.useState('7d')
    const [lang, setLang] = React.useState('orig')
    const [zhMap, setZhMap] = React.useState({})
    const [items, setItems] = React.useState([])
    const [total, setTotal] = React.useState(null)
    const [loading, setLoading] = React.useState(true)
    const [error, setError] = React.useState(null)
    const [rateReset, setRateReset] = React.useState(null)
    const [note, setNote] = React.useState(null)
    const [detail, setDetail] = React.useState(null)
    const [tick, setTick] = React.useState(0)
    const [page, setPage] = React.useState(1)
    const [hasMore, setHasMore] = React.useState(false)
    const [loadingMore, setLoadingMore] = React.useState(false)
    const [remaining, setRemaining] = React.useState(null)
    const [verifyOn, setVerifyOn] = React.useState(true)
    const [verifyMap, setVerifyMap] = React.useState({})
    const [verifying, setVerifying] = React.useState(false)
    const [token, setToken] = React.useState(getToken())
    const [showToken, setShowToken] = React.useState(false)
    const [tokenInput, setTokenInput] = React.useState('')
    const [now, setNow] = React.useState(Date.now())

    function buildQ(kw) {
      let searchKw = kw
      let qnote = null
      if (kw && hasCJK(kw)) {
        const mapped = mapZh(kw)
        if (hasLatin(mapped)) {
          searchKw = mapped.replace(/[\u4e00-\u9fff]+/g, ' ').replace(/\s+/g, ' ').trim()
          qnote = '已将中文关键词映射为英文搜索：\u201c' + searchKw + '\u201d'
        } else {
          searchKw = kw
          qnote = '按原始中文关键词搜索；可尝试英文关键词获得更多结果'
        }
      }
      let q = scope === 'topic'
        ? (searchKw ? searchKw + ' ' + TOPIC_Q : TOPIC_Q)
        : (searchKw || 'deepseek harness')
      if (when !== 'all' && WHEN_DAYS[when]) q += ' created:>=' + windowDate(WHEN_DAYS[when])
      return { q: q, note: qnote }
    }

    React.useEffect(function () {
      let alive = true
      setError(null)
      setNote(null)
      setRateReset(null)
      if (items.length === 0) setLoading(true)
      const kw = query.trim()
      const timer = window.setTimeout(function () {
        const built = buildQ(kw)
        if (built.note) setNote(built.note)
        searchCatalog(built.q, sort, 1).then(function (res) {
          if (!alive) return
          setItems(res.items)
          setTotal(res.total)
          setPage(1)
          setHasMore(res.total > 24)
          if (res.remaining !== null && res.remaining !== undefined) setRemaining(res.remaining)
          setError(null)
        }).catch(function (e) {
          if (!alive) return
          setError(String((e && e.message) || e))
          if (e && e.rate && typeof e.reset === 'number') setRateReset(e.reset)
          if (e && e.tokenBad) setToken('')
        }).then(function () {
          if (alive) setLoading(false)
        })
      }, kw ? 400 : 30)
      return function () { alive = false; window.clearTimeout(timer) }
    }, [query, sort, scope, when, tick, token])

    React.useEffect(function () {
      if (scope !== 'all') return
      let cancelled = false
      const missing = items.filter(function (r) { return !verifyCache.has(r.full_name) }).slice(0, 24)
      if (!missing.length) return
      setVerifying(true)
      ;(async function () {
        for (let i = 0; i < missing.length; i += 4) {
          const batch = missing.slice(i, i + 4)
          const results = await Promise.all(batch.map(function (r) {
            return verifyRepo(r.full_name).then(function (v) { return [r.full_name, v] })
          }))
          if (cancelled) return
          setVerifyMap(function (prev) {
            const next = Object.assign({}, prev)
            results.forEach(function (p) { next[p[0]] = p[1] })
            return next
          })
        }
        if (!cancelled) setVerifying(false)
      })()
      return function () { cancelled = true }
    }, [items, scope])

    React.useEffect(function () {
      if (lang !== 'zh') return
      const missing = []
      items.forEach(function (r) {
        const d = r && r.description
        if (d && !zhMap[d] && !transCache.has(d) && missing.length < 30) missing.push(d)
      })
      if (!missing.length) return
      gtxBatch(missing).then(function (m) {
        setZhMap(function (prev) { return Object.assign({}, prev, m) })
      }).catch(function () {})
    }, [items, lang])

    React.useEffect(function () {
      if (rateReset === null) return
      const timer = window.setInterval(function () {
        if (Date.now() / 1000 >= rateReset) { setRateReset(null); setError(null) }
        setNow(Date.now())
      }, 5000)
      return function () { window.clearInterval(timer) }
    }, [rateReset])

    function descOf(r) {
      const d = r && r.description
      if (!d) return '（无描述）'
      if (lang === 'zh' && zhMap[d]) return zhMap[d]
      return d
    }

    function loadMore() {
      setLoadingMore(true)
      const built = buildQ(query.trim())
      searchCatalog(built.q, sort, page + 1).then(function (res) {
        setItems(function (prev) { return prev.concat(res.items) })
        setPage(page + 1)
        setHasMore(res.total > (page + 1) * 24)
        if (typeof res.total === 'number') setTotal(res.total)
        setLoadingMore(false)
      }).catch(function (e) {
        setError(String((e && e.message) || e))
        if (e && e.rate && typeof e.reset === 'number') setRateReset(e.reset)
        setLoadingMore(false)
      })
    }

    function openDetail(repo) {
      setDetail({ loading: true, data: null, error: null })
      const full = repo.full_name
      const candidates = ['README.md', 'readme.md', 'Readme.md', 'README.MD']
      ;(async function () {
        let readme = null
        let readmeTruncated = false
        for (let i = 0; i < candidates.length; i++) {
          const t = await rawFetch('https://raw.githubusercontent.com/' + full + '/HEAD/' + candidates[i])
          if (t !== null) {
            readmeTruncated = t.length > 16000
            readme = t.slice(0, 16000)
            break
          }
        }
        setDetail({
          loading: false,
          error: null,
          data: Object.assign({}, repo, { readme: readme, readmeTruncated: readmeTruncated }),
        })
      })().catch(function (e) {
        setDetail({ loading: false, data: null, error: String((e && e.message) || e) })
      })
    }

    if (variant === 'overlay' && !open) return null

    function sortBtn(value, label) {
      const active = sort === value
      return el('button', {
        key: value,
        className: 'dshws-sort' + (active ? ' dshws-active' : ''),
        onClick: function () { setSort(value) },
      }, label)
    }

    const langNote = lang === 'zh' ? '描述为机器翻译，仅供参考。' : null

    let visible = items
    let hiddenCount = 0
    if (scope === 'all' && verifyOn) {
      visible = items.filter(function (r) { return verifyMap[r.full_name] !== 'no' })
      hiddenCount = items.length - visible.length
    }
    const countdown = rateReset !== null ? Math.max(0, Math.ceil(rateReset - now / 1000)) : null
    const whenText = when === 'all' ? '' : ' \u00b7 ' + WHEN_LABEL[when]

    const content = detail
      ? el(DetailView, { detail: detail, onBack: function () { setDetail(null) }, desc: descOf(detail.data) })
      : el('div', { className: 'dshws-body' },
          el('div', { className: 'dshws-toolbar' },
            el('input', {
              className: 'dshws-search',
              placeholder: '搜索插件（支持中文关键词）\u2026',
              value: query,
              onChange: function (e) { setQuery(String((e.target && e.target.value) || '')) },
            }),
            el('select', {
              className: 'dshws-scope',
              value: scope,
              onChange: function (e) { setScope(e.target && e.target.value === 'topic' ? 'topic' : 'all') },
            },
              el('option', { value: 'topic' }, '插件话题'),
              el('option', { value: 'all' }, '全站搜索'),
            ),
            el('select', {
              className: 'dshws-scope',
              value: when,
              onChange: function (e) { setWhen(e.target && e.target.value ? e.target.value : 'all') },
            },
              el('option', { value: 'all' }, '不限时间'),
              el('option', { value: '7d' }, '近7天飙升'),
              el('option', { value: '30d' }, '近30天飙升'),
              el('option', { value: '90d' }, '近90天飙升'),
            ),
            el('select', {
              className: 'dshws-scope',
              value: lang,
              onChange: function (e) { setLang(e.target && e.target.value === 'zh' ? 'zh' : 'orig') },
            },
              el('option', { value: 'orig' }, '描述原文'),
              el('option', { value: 'zh' }, '描述中文'),
            ),
            el('label', { className: 'dshws-check' },
              el('input', { type: 'checkbox', checked: verifyOn, onChange: function (e) { setVerifyOn(!!(e.target && e.target.checked)) } }),
              '只显示疑似 DSH 插件'),
            el('div', { className: 'dshws-sorts' }, sortBtn('stars', '\u2605 最热'), sortBtn('updated', '\u23f0 最新')),
            el('button', { className: 'dshws-mini', title: '设置', onClick: function () { setShowToken(!showToken) } }, '\u2699'),
          ),
          showToken ? el('div', { className: 'dshws-tokenrow' },
            el('input', {
              className: 'dshws-search',
              style: { flex: '1 1 260px' },
              placeholder: 'GitHub Token（可选，仅存本机浏览器）',
              value: tokenInput,
              onChange: function (e) { setTokenInput(String((e.target && e.target.value) || '')) },
            }),
            el('button', { className: 'dshws-mini', onClick: function () { const v = tokenInput.trim(); saveToken(v); setToken(v); setTokenInput(''); } }, '保存'),
            token ? el('button', { className: 'dshws-mini', onClick: function () { saveToken(''); setToken(''); } }, '清除') : null,
            el('span', { className: 'dshws-note' }, '匿名 10 次/分；带 Token 30 次/分'),
          ) : null,
          (note || langNote) ? el('div', { className: 'dshws-note' }, note || langNote) : null,
          verifying ? el('div', { className: 'dshws-note' }, '正在验证插件特征\u2026') : null,
          hiddenCount > 0 ? el('div', { className: 'dshws-note' }, '已隐藏 ' + hiddenCount + ' 个未检出插件特征的仓库') : null,
          loading && items.length === 0 ? el('div', { className: 'dshws-status' }, '加载中\u2026') : null,
          error ? el('div', { className: 'dshws-error' },
            '\u26a0 ' + error + (countdown !== null ? '（约 ' + countdown + ' 秒后恢复）' : ''),
            el('button', { className: 'dshws-back', style: { margin: '8px 0 0', display: 'block' }, onClick: function () { setTick(tick + 1) } }, '重试'),
          ) : null,
          !loading && !error && visible.length === 0
            ? (scope === 'topic'
                ? el('div', { className: 'dshws-status' },
                    '还没有仓库使用 topic:dsh-plugin。生态还年轻 \u2014 发布插件时给仓库打上 topic:dsh-plugin 即可出现在这里。',
                    el('div', { style: { marginTop: 8 } },
                      el('button', { className: 'dshws-mini', onClick: function () { setScope('all') } }, '去全站搜索')),
                  )
                : el('div', { className: 'dshws-status' }, '没有找到匹配的仓库（或全部被特征过滤隐藏）。可以试试英文关键词，或关闭过滤。'))
            : null,
          el('div', { className: 'dshws-list' },
            visible.map(function (r) {
              return el(RepoCard, {
                key: r.full_name,
                repo: r,
                desc: descOf(r),
                verify: verifyMap[r.full_name],
                onOpen: function () { openDetail(r) },
              })
            }),
          ),
          el('div', { className: 'dshws-footer' },
            el('span', null, '已显示 ' + visible.length + ' / ' + (total === null ? '?' : total)),
            remaining !== null ? el('span', { className: 'dshws-muted' }, '搜索额度剩余 ' + remaining + (countdown !== null ? ' \u00b7 恢复 ' + countdown + 's' : '')) : null,
            hasMore ? el('button', { className: 'dshws-loadmore', onClick: loadMore, disabled: loadingMore }, loadingMore ? '加载中\u2026' : '加载更多') : null,
          ),
        )

    const header = el('div', { className: 'dshws-header' },
      el('span', { className: 'dshws-title' }, '\uD83E\uDDE9 插件工坊'),
      el('span', { className: 'dshws-sub' },
        total === null ? '' : (scope === 'topic' ? 'DSH 插件话题' : '全站') + ' \u00b7 共 ' + total + ' 个结果 \u00b7 ' + (sort === 'stars' ? '按热度' : '按最新') + whenText),
      variant === 'overlay' ? el('button', { className: 'dshws-close', onClick: store.close, title: '关闭' }, '\u2715') : null,
    )

    return el('div', { className: 'dshws-root' + (variant === 'overlay' ? ' dshws-overlay' : ' dshws-tab') }, header, content)
  }

  var WorkshopComponent = Workshop
  var hasReact = true
} else {
  var WorkshopComponent = null
  var hasReact = false
}

// ---------------- 样式 ----------------
const CSS = '\n.dshws-root{display:flex;flex-direction:column;font-size:13px;line-height:1.5;color:inherit;min-height:0;}\n.dshws-tab{height:100%;}\n.dshws-overlay{position:fixed;top:20px;right:20px;bottom:20px;width:min(760px,calc(100vw - 40px));background:#fff;border:1px solid rgba(127,127,127,.35);border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.25);z-index:1000;pointer-events:auto;overflow:hidden;color:#1f2328;}\n@media (prefers-color-scheme: dark){.dshws-overlay{background:#16181d;color:#e6e6e6;}}\n.dshws-header{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid rgba(127,127,127,.25);flex:0 0 auto;}\n.dshws-title{font-weight:600;font-size:14px;white-space:nowrap;}\n.dshws-sub{opacity:.65;font-size:11px;flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}\n.dshws-close{border:none;background:transparent;cursor:pointer;font-size:13px;color:inherit;opacity:.7;padding:4px 8px;border-radius:6px;}\n.dshws-close:hover{opacity:1;background:rgba(127,127,127,.15);}\n.dshws-body{display:flex;flex-direction:column;min-height:0;flex:1 1 auto;overflow:hidden;}\n.dshws-toolbar{display:flex;gap:8px;align-items:center;padding:10px 14px;flex:0 0 auto;flex-wrap:wrap;}\n.dshws-search{flex:1 1 200px;min-width:140px;padding:6px 10px;border-radius:8px;border:1px solid rgba(127,127,127,.4);background:rgba(127,127,127,.08);color:inherit;font-size:13px;outline:none;}\n.dshws-search:focus{border-color:rgba(64,120,255,.7);}\n.dshws-scope{padding:6px 8px;border-radius:8px;border:1px solid rgba(127,127,127,.4);background:rgba(127,127,127,.08);color:inherit;font-size:13px;}\n.dshws-sorts{display:flex;gap:4px;}\n.dshws-sort{padding:6px 12px;border-radius:8px;border:1px solid rgba(127,127,127,.4);background:rgba(127,127,127,.08);color:inherit;font-size:12px;cursor:pointer;}\n.dshws-sort.dshws-active{background:rgba(64,120,255,.18);border-color:rgba(64,120,255,.7);font-weight:600;}\n.dshws-check{display:inline-flex;align-items:center;gap:5px;font-size:12px;cursor:pointer;white-space:nowrap;}\n.dshws-tokenrow{display:flex;gap:8px;align-items:center;padding:0 14px 8px;flex-wrap:wrap;}\n.dshws-note{font-size:11px;opacity:.7;padding:2px 14px 0;flex:0 0 auto;}\n.dshws-list{flex:1 1 auto;overflow-y:auto;padding:4px 14px 14px;display:flex;flex-direction:column;gap:8px;min-height:0;}\n.dshws-card{display:flex;gap:10px;padding:10px;border:1px solid rgba(127,127,127,.25);border-radius:10px;cursor:pointer;background:rgba(127,127,127,.04);}\n.dshws-card:hover{border-color:rgba(64,120,255,.6);background:rgba(64,120,255,.07);}\n.dshws-avatar{width:34px;height:34px;border-radius:8px;flex:0 0 auto;object-fit:cover;background:rgba(127,127,127,.2);}\n.dshws-avatar-lg{width:40px;height:40px;}\n.dshws-card-body{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1 1 auto;}\n.dshws-card-title{font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}\n.dshws-card-desc{font-size:12px;opacity:.75;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}\n.dshws-card-meta{display:flex;gap:6px;flex-wrap:wrap;}\n.dshws-pill{font-size:11px;padding:2px 8px;border-radius:999px;background:rgba(127,127,127,.14);white-space:nowrap;}\n.dshws-pill.dshws-muted{opacity:.7;}\n.dshws-badge-installed{background:rgba(46,160,67,.16);color:#2ea043;}\n.dshws-status{padding:14px;font-size:12px;opacity:.8;}\n.dshws-error{padding:14px;font-size:12px;color:#d64545;}\n.dshws-back{align-self:flex-start;margin:10px 14px 0;padding:5px 12px;border-radius:8px;border:1px solid rgba(127,127,127,.4);background:transparent;color:inherit;cursor:pointer;font-size:12px;}\n.dshws-detail{overflow-y:auto;padding-bottom:14px;}\n.dshws-detail-head{padding:4px 14px 0;display:flex;flex-direction:column;gap:8px;}\n.dshws-detail-title{font-size:16px;font-weight:700;display:flex;align-items:center;gap:10px;flex-wrap:wrap;}\n.dshws-link{color:#4c7dff;text-decoration:none;font-size:12px;font-weight:400;}\n.dshws-link:hover{text-decoration:underline;}\n.dshws-section{padding:10px 14px;}\n.dshws-section-label{font-size:11px;font-weight:700;text-transform:uppercase;opacity:.6;letter-spacing:.05em;margin-bottom:6px;}\n.dshws-install{font-family:ui-monospace,Consolas,monospace;font-size:12px;background:rgba(127,127,127,.12);border:1px solid rgba(127,127,127,.25);border-radius:8px;padding:10px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;margin:0;}\n.dshws-footer{display:flex;align-items:center;gap:12px;padding:8px 14px;border-top:1px solid rgba(127,127,127,.2);font-size:11px;opacity:.85;flex:0 0 auto;}\n.dshws-muted{opacity:.7;}\n.dshws-loadmore{margin-left:auto;padding:5px 14px;border-radius:8px;border:1px solid rgba(64,120,255,.6);background:transparent;color:#4c7dff;cursor:pointer;font-size:12px;}\n.dshws-loadmore:hover{background:rgba(64,120,255,.12);}\n.dshws-loadmore:disabled{opacity:.5;cursor:default;}\n.dshws-mini{font-size:11px;color:#4c7dff;background:transparent;border:1px solid rgba(64,120,255,.5);border-radius:6px;padding:2px 8px;cursor:pointer;}\n.dshws-mini:hover{background:rgba(64,120,255,.12);}\n.dshws-mini-on{background:rgba(64,120,255,.18);border-color:rgba(64,120,255,.7);font-weight:600;}\n.dshws-md{font-size:12.5px;line-height:1.6;word-break:break-word;}\n.dshws-h{font-weight:700;margin:10px 0 4px;}\n.dshws-h1{font-size:15px;border-bottom:1px solid rgba(127,127,127,.25);padding-bottom:4px;}\n.dshws-h2{font-size:14px;}\n.dshws-h3{font-size:13px;}\n.dshws-p{margin:3px 0;}\n.dshws-code{background:rgba(127,127,127,.1);border:1px solid rgba(127,127,127,.22);border-radius:8px;padding:8px 10px;overflow-x:auto;font-family:ui-monospace,Consolas,monospace;font-size:11.5px;margin:6px 0;white-space:pre-wrap;}\n.dshws-inline-code{font-family:ui-monospace,Consolas,monospace;font-size:11.5px;background:rgba(127,127,127,.16);padding:1px 5px;border-radius:4px;}\n.dshws-ul{margin:3px 0 3px 18px;padding:0;}\n.dshws-a{color:#4c7dff;text-decoration:none;}\n.dshws-a:hover{text-decoration:underline;}\n.dsws-sidebar-icon{font-size:15px;line-height:1;display:inline-flex;align-items:center;}\ndiv[class*="_collapsed"] .dsws-sidebar-label{display:none;}\n'

function injectStyles() {
  if (typeof document === 'undefined') return
  const tagId = '@dsh-external/dsh-plugin-workshop/styles'
  if (document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = '@dsh-external/dsh-plugin-workshop'
  tag.dataset.pluginCss = tagId
  tag.textContent = CSS
  document.head.appendChild(tag)
}

// ---------------- 插件入口 ----------------
function apply(ctx) {
  console.log(TAG, 'apply, React =', hasReact)
  const slots = ctx.get('slots')
  if (slots !== undefined && WorkshopComponent !== null) {
    slots.inject('shell.overlay', function () {
      return slots.register(
        { name: 'shell.overlay', id: 'plugin-workshop-static', order: 50, label: '插件工坊' },
        function () { return React.createElement(WorkshopComponent, { variant: 'overlay' }) },
      )
    })
    slots.inject('settings.plugins.tab', function () {
      return slots.register(
        { name: 'settings.plugins.tab', id: 'workshop-static', order: 20, label: '插件工坊' },
        function () { return React.createElement(WorkshopComponent, { variant: 'tab' }) },
      )
    })
  }
  if (typeof document !== 'undefined') {
    injectStyles()
    installSidebarButton()
    watchSidebar()
    ctx.effect(function () {
      return function () {
        if (obs) { obs.disconnect(); obs = null }
        window.clearTimeout(installTimer)
        removeSidebarButton()
      }
    }, 'dsh-plugin-workshop: 侧栏入口清理')
    ctx.effect(function () {
      return function () {
        const s = document.querySelector('style[data-plugin="@dsh-external/dsh-plugin-workshop"]')
        if (s) s.remove()
      }
    }, 'dsh-plugin-workshop: 样式清理')
  }
}

module.exports = { apply }
