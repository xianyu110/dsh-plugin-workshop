# 工坊统计服务（Phase A · 可选增强层）

零服务器是工坊的默认形态；本目录是**可选**的远程统计服务参考实现（Cloudflare Worker + D1，免费额度足够），部署后工坊自动解锁：

- 卡片上的 **↓ 装机 N · 近7天 +M** 社区装机徽章
- `/trending` **真·飙升榜**（按实际安装净增长，而非 stars/创建时间近似）

**不部署 = 完全无影响**：宿主侧仅在 `DSH_WORKSHOP_STATS_URL` 环境变量存在时才上报，客户端拉取失败静默降级。

## 隐私

- 只上报 `full_name` + 事件类型（install/update/uninstall）+ 匿名安装 ID（每台机器一个随机 UUID，存于 profile 目录）；
- 无用户身份、无路径、无 IP 持久化。匿名 ID 仅用于防刷参考，不跨服务关联。

## API

| 端点 | 说明 |
|---|---|
| `POST /events` | `{ full_name, event, install_id }`，记录事件并更新计数器 |
| `GET /stats?repos=a/b,c/d` | 每仓库 totals + `installs7d` / `net7d` |
| `GET /trending?days=7&limit=20` | 按窗口内净增长排序 |

## 部署（Cloudflare）

```bash
cd remote/worker

# 1. 创建 D1 数据库并记录 database_id
wrangler d1 create dsh-workshop-stats

# 2. 把 database_id 填进 wrangler.toml 的 REPLACE_WITH_YOUR_D1_DATABASE_ID

# 3. 建表
wrangler d1 execute dsh-workshop-stats --remote --file=schema.sql

# 4. 部署
wrangler deploy
# → 得到 https://dsh-workshop-stats.<你的子域>.workers.dev
```

## 接入工坊

给 dsh web 进程设置环境变量（例）：

```bat
set DSH_WORKSHOP_STATS_URL=https://dsh-workshop-stats.<你的子域>.workers.dev
```

重启 dsh web 后：`/dsh-plugin-workshop/api/status` 返回 `statsUrl`，客户端开始显示装机徽章并上报事件。

## 本地验证

```bash
node remote/test/harness.mjs
```

用内存 Mock D1 跑通事件上报、stats 查询、trending 排序与参数校验。

## 后续（Phase B 起）

- 评分/评论（需要更强的身份与防滥用设计）
- 更新徽章（服务端镜像最新版本，替代逐仓库 API 调用）
- 服务端全文/中文搜索索引
