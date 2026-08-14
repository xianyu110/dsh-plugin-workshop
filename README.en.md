# 🧩 DSH Plugin Workshop (dsh-plugin-workshop)

A **Steam Workshop-style plugin browser** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) — zero-server, single-package, living right inside the DSH Web UI sidebar, directly under the "New Session" button.

> Unlike the centralized marketplace-platform approach of [DSH_Creative_Workshop](https://github.com/OBdangshang07/DSH_Creative_Workshop), this project takes the **zero-infrastructure** route: catalog, search, popularity and publish time are all provided by GitHub for free. No control plane, no account system — install into a profile and it just works.

[简体中文](README.md) | English

## ✨ Features

- **Permanent sidebar entry**: cloned under the official "New Session" button with identical styling (DOM clone of the official button, adapts to wide/rail sidebar states, survives refreshes and restarts)
- **Search & sorting**: keyword search (Chinese input auto-mapped to English keywords), ★ hottest / ⏰ newest, and **trending time windows** (repos created in the last 7/30/90 days sorted by stars — the closest GitHub-API approximation of Steam's Trending)
- **DSH plugins only by default**: the "Plugin topic" scope (`topic:dsh-plugin`); the whole-site mode includes **plugin-signature verification** (checks `package.json` `dsh` field / `cordis.yml` etc. via the raw CDN — costs no API quota) and filters out unrelated repos by default
- **Bilingual experience**: one-click switch between original / machine-translated Chinese descriptions; README can be fully translated (Google Translate endpoint, cached)
- **Smart one-click install / uninstall**: repo type is auto-detected — bundle-type (package.json declares `dsh.*`) installs via the official `dsh plugin add` flow plus an auto-written profile activation row; preset-type is copied into `.agent-presets`. Uninstall reverses the install path (removes the activation row + `pnpm remove`, or deletes the directory); missing git is reported with clear guidance
- **Detail page**: stars/forks/language/license/created time, lightweight README rendering (headings/bold/code/lists/links), manual install command, GitHub link
- **Quota transparency**: live GitHub search rate-limit remaining + recovery countdown; optional GitHub Token (30 req/min, stored in the local browser only)
- **Zero-server**: all data comes from the GitHub search API (browser-direct, CORS) + raw.githubusercontent.com (verification & README)

## 📦 Install

For the web profile:

```bash
# 1. Add this package to the profile's dependencies (dsh plugin forwards to pnpm)
dsh plugin --profile web add "github:yyyyukari/dsh-plugin-workshop"

# 2. Add the activation row to $DSH_HOME/profiles/web/cordis.patch.yml:
#    - insert:
#        - id: plugin-workshop
#          name: '@dsh-external/dsh-plugin-workshop'

# 3. Restart dsh web and refresh the browser
```

After activation, the "🧩 插件工坊" button appears under "New Session" in the sidebar; the workshop also lives in Settings → Plugins as a tab.

## 🧭 Usage

| Goal | How |
|---|---|
| Find DSH plugins | Default view is the plugin-topic list (repos tagged `topic:dsh-plugin`) |
| Trending | Time dropdown: 7/30/90-day windows + ★ hottest |
| Search in Chinese | Type Chinese words like 天气 / 翻译 — auto-mapped to English keywords |
| Read Chinese descriptions | Toolbar "描述中文"; detail page "翻译 README" |
| Install / update / uninstall | Detail page buttons, install path chosen by repo type (needs git, warned otherwise) |
| Raise search quota | Toolbar ⚙ → paste a GitHub Personal Access Token |

## 🏗️ Architecture

- **Host half** (`lib/index.js`): registers same-origin HTTP routes on the `webServer` service — `/dsh-plugin-workshop/api/{status,install,update,uninstall}` — smart install (bundle/preset type detection) and reverse uninstall with strict input validation and a custom-header CSRF guard
- **Client half** (`lib/client.js`): React over platform seed modules; DOM-clones the official sidebar button with a MutationObserver self-heal; mounts the workshop in `shell.overlay` and `settings.plugins.tab`
- **Data flow**: GitHub search API (10 req/min anonymous) → signature verification & README via raw CDN (no quota) → machine translation via Google gtx
- **Security**: no third-party code is executed by the browser half; installs only write under `.agent-presets`; the Token lives in localStorage only

## 🗺️ Roadmap

- [x] v1.1 One-click install / update (host API: git detection, clone/pull into `.agent-presets`)
- [x] v1.2 Smart install / uninstall: bundle-type via official `dsh plugin add` + activation row, preset-type via `.agent-presets`, uninstall reverses the path (tested end-to-end)
- [ ] Installed-plugin management page
- [ ] Community index exposure (awesome-dsh-plugin / awesome-dsh-plugins / awesome-deepseek-harness — PRs open)

## 📄 License

MIT
