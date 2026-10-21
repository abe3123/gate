# VPNGate SSTP 家宽节点（edgetunnel 链式代理） 🚀

自动抓取 [VPN Gate](https://www.vpngate.net/) 的 SSTP 家宽/机房节点，调用检测 Worker 逐个验证可用性，按国家分组、标注住宅/机房，生成可直接通过 **URL 自动轮换** 的节点清单。**每 30 分钟自动更新一次。**

> 核心价值：VPN Gate 的 SSTP 节点 30 分钟就换一批，手动测试筛选太痛苦。本仓库把它全自动了——你只需把 `nodes.txt` 的网址填进 edgetunnel 后台一次，之后节点每 30 分钟自动换，零手动。

---

## 架构（数据流向）

~~~text
VPN Gate 官方源
      │  (每 30 分钟，GitHub Actions 定时抓取)
      ▼
筛选 SSTP 节点 → 去重
      │
      ▼
检测 Worker (CheckSocks5，部署在 Cloudflare)
      │  GET /check?sstp=vpn:vpn@host:port
      │  返回 success + 出口 IP(住宅/机房判定)
      ▼
保留成功节点 → 按国家分组 → 住宅/机房标注 → 延迟排序
      │
      ▼
生成 nodes.txt (发布到 Cloudflare Pages 或 GitHub Pages)
      │
      ▼
edgetunnel 后台「自定义优选IP」框填 https://…/nodes.txt
      │  edgetunnel 每次生成订阅时自动 fetch → 解析 $sstp:// → 套链式代理
      ▼
客户端订阅 edgetunnel 订阅 → 使用 SSTP 家宽节点 (每 30 分钟自动换)
~~~

---

## 🚀 极速部署：纯 Cloudflare 运行（无需 GitHub，无需 Python）

本项目现已全面支持 **纯 Cloudflare Pages / Worker 原生运行**！
不需要 GitHub 账号、不需要 GitHub Actions、不需要 Python 环境，全部抓取与检测逻辑 100% 在 Cloudflare 边缘计算（V8 引擎）中自动完成。

### 方式 1：Cloudflare Pages 直接上传（推荐，带可视化面板）
1. 登录 [Cloudflare 控制台](https://dash.cloudflare.com/)，点击左侧 **Workers 和 Pages**。
2. 点击 **创建** -> 选择 **Pages** -> 点击 **上传资产 (Upload assets)**。
3. 输入项目名称（例如 `gate`）。
4. 上传本仓库根目录下的 `cloudflare-pages-deploy.zip`（或者直接将 `web` 目录拖拽到上传区域）。
5. 点击 **部署站点 (Deploy site)**。
6. 完成！你的专属节点与面板地址即为：
   - ⚡ **默认节点订阅（免检测极速模式 · 80+ 节点 · 住宅优先）**：`https://你的项目名.pages.dev/nodes.txt`
   - 🏡 **仅住宅家宽订阅（纯家宽 IP）**：`https://你的项目名.pages.dev/nodes.txt?type=residential`
   - 🇯🇵 **指定国家订阅（如仅日本节点）**：`https://你的项目名.pages.dev/nodes.txt?country=JP`
   - 🔍 **严格检测订阅（Worker 测活与反查）**：`https://你的项目名.pages.dev/nodes.txt?mode=check`
   - 📊 **可视化控制看板**：`https://你的项目名.pages.dev/`

> **💡 核心优化与特性**：
> 1. **智能家宽启发式判定**：免检测模式下自动识别 SoftEther 动态 DDNS 主机名（如 `vpn\d+`），精准区分 **住宅 IP (60+ 个)** 与 **数据中心机房**，并将住宅宽带优先排序！
> 2. **灵活参数定制订阅**：支持在 `nodes.txt` URL 上追加 `?type=residential`、`?country=JP`、`?limit=30` 等组合参数定制专属节点；
> 3. **Anycast 优选融合**：自动将裸 `sstp://` 节点与 Cloudflare 全球 CDN 优选入口池绑定（例如 `saas.sin.fan:443#日本-住宅-01$sstp://...`），多源优选容错防 403 阻断；
> 4. **看板体验升级**：内置即时搜索、国家折叠面板、住宅/机房分布统计、免弹窗无感复制等现代微交互。

### 方式 2：作为 Cloudflare Worker 直接粘贴部署（最快 30 秒上线）
1. 登录 Cloudflare 控制台，点击 **Workers 和 Pages** -> **创建 Worker**，起名如 `gate`，点击 **部署**。
2. 进入 Worker 详情页，点击右上角 **编辑代码**。
3. 清空左侧代码编辑器，将本项目根目录的 `_worker.js` 全部代码复制粘贴进去。
4. 点击右上角 **保存并部署**。
5. 你的专属节点地址即为：
   - `https://gate.你的用户名.workers.dev/nodes.txt`

---

## 一、完整部署教程（从零开始）

### 前置条件
- 一个 Cloudflare 账号（免费即可）
- 一个 GitHub 账号
- 一个已转入 Cloudflare 的域名（可选，但强烈推荐）

### 第 1 步：部署 edgetunnel（核心使用端）

1. 登录 Cloudflare 控制台，点击左侧 **Workers 和 Pages**
2. 点击 **创建** → 选择 **创建 Worker**，起名 `edgetunnel`，点击 **部署**
3. 打开 https://github.com/cmliu/edgetunnel/blob/main/_worker.js ，复制全部代码
4. 回到 Cloudflare Worker 编辑器，粘贴代码，点击 **保存并部署**
5. 在 **设置** → **变量** 中，添加变量 `ADMIN`，值填你的管理员密码
6. 在 **绑定** 中，添加 KV 命名空间绑定，变量名称填 `KV`
7. （推荐）在 **触发器** 中绑定自定义域名
8. 浏览器访问 `https://你的域名/admin`，登录后台
9. **在后台首页记下你的 UUID 和节点域名**（后面要用）

> **关键**：`UUID` 和 `节点域名` 是 edgetunnel 自己的配置，**不需要**在 `vpngate.py` 中设置。`vpngate.py` 只负责生成 `nodes.txt`，edgetunnel 会用它自己的 UUID/域名去生成最终订阅。

### 第 2 步：部署检测 Worker（CheckSocks5）

1. 打开 https://github.com/lsh8848/cm-Workers-CheckSocks5 ，点 **Fork**
2. 进 Cloudflare 控制台 → Workers 和 Pages → 创建 → 创建 Worker
3. 把 `_worker.js` 的全部内容粘贴进编辑器，点「部署」
4. 记下这个 Worker 的域名，形如 `https://xxx.你的用户名.workers.dev`
5. 验证：浏览器打开 `https://你的Worker域名/check?sstp=vpn:vpn@任意节点:端口` ，能返回 JSON 即成功

### 第 3 步：Fork 本仓库

在 GitHub 上打开本仓库，点 **Fork**，复制到你账号下。

### 第 4 步：选择部署方式（Cloudflare Pages 或 GitHub Pages）

强烈推荐部署到 **Cloudflare Pages**：全球 Anycast CDN 加速、国内访问顺畅不丢包、支持免费绑定自定义域名。

#### 方案 A：通过 GitHub Actions 自动发布到 Cloudflare Pages（强烈推荐 ⭐⭐⭐⭐⭐）
> **优势**：每 30 分钟由 GitHub Actions 自动定时检测节点并直接上传到 Cloudflare Pages，**零消耗 Cloudflare Pages 每月 500 次构建限额**。

1. **获取 Cloudflare API 凭证**：
   - 登录 Cloudflare 控制台，进入右上角 **我的个人资料** -> **API 令牌** -> 点击 **创建令牌**。
   - 选择 **自定义令牌** (Create Custom Token) -> 点击 **开始使用**：
     - **令牌名称**：如 `Pages-Deploy`
     - **权限**：选择 **账户** (Account) -> **Cloudflare Pages** -> **编辑** (Edit)
     - 点击 **继续以显示摘要** -> **创建令牌**，复制并保存好该 Token。
   - 在 Cloudflare 控制台任意页面右侧或 URL 中获取你的 **Account ID**（账户 ID，32 位字符串）。
2. **在 GitHub 仓库添加 Secrets**：
   - 进你 fork 的仓库 -> **Settings** -> **Secrets and variables** -> **Actions** -> 点击 **New repository secret**：
     - `CLOUDFLARE_API_TOKEN`：填入上面生成的 API 令牌
     - `CLOUDFLARE_ACCOUNT_ID`：填入你的 Cloudflare 账户 ID
     - `CLOUDFLARE_PROJECT_NAME`（可选）：填入你在 Pages 上的项目名称（默认会自动使用 `gate`）
     - `CHECK_WORKER`（可选）：如果你在第 2 步部署了自己的检测 Worker，可填入形如 `https://xxx.workers.dev/check?sstp=vpn:vpn@`；若不填则默认使用内置公共检测服务。
3. **启用 Actions 定时任务**：
   - 进仓库 **Actions** 标签页，如果提示启用 Actions 请点击启用。
   - 手动触发一次：点击左侧 **VPN Gate Node Check** -> **Run workflow** -> 点击绿色 **Run workflow** 按钮。
   - 运行完成后，工作流会自动创建并部署 Cloudflare Pages，并在日志中输出你的专属订阅地址：
     ~~~text
     https://你的项目名.pages.dev/nodes.txt
     ~~~

#### 方案 B：直接在 Cloudflare Pages 控制台关联构建
1. 登录 Cloudflare 控制台 -> **Workers 和 Pages** -> 点击 **创建** -> **Pages** -> 选择 **连接到 Git**。
2. 授权并选中你 Fork 的 `gate` 仓库。
3. 构建配置：
   - **框架预设 (Framework preset)**：选择 `无 (None)`
   - **构建命令 (Build command)**：`pip install -r requirements.txt && python vpngate.py`
   - **构建输出目录 (Build output directory)**：`public`
   - **环境变量 (Environment variables)**：
     - 添加 `CHECK_WORKER`，值填你的检测 Worker 域名（可选）
4. 点击 **保存并部署**。
> *注：Cloudflare Pages 仅在代码 Push 时自动构建。如需定时更新，可在 Pages 项目的「设置」->「构建与部署」中创建 Deploy Hook，配合外部定时请求（如 cron-job.org），但请注意免费版每月有 500 次构建限额。*

---

### 第 5 步：确认产物

无论使用方案 A 还是方案 B，部署成功后直接访问你的站点：
- **节点订阅地址**：`https://你的项目名.pages.dev/nodes.txt`
- **可视化状态面板**：`https://你的项目名.pages.dev/` （顶部自带一键复制订阅网址按钮）

浏览器打开 `nodes.txt`，能看到包含住宅/机房标注的优选节点列表即表示全部打通！

---

## 二、使用教程（URL 自动轮换，一次配置永久生效）

1. 进 edgetunnel 后台（你的域名/admin），找到「自定义优选IP」文本框
2. 粘贴**一行网址**：
   ~~~text
   https://你的项目名.pages.dev/nodes.txt
   ~~~
   *(若使用 GitHub Pages，则填 `https://你的GitHub用户名.github.io/仓库名/nodes.txt`)*
3. 点保存
4. 客户端刷新订阅 → 每次刷新 edgetunnel 都重新拉取一次 nodes.txt，节点自动更新

> 原理：`nodes.txt` 是纯节点行版本（无注释头），每行 `入口域名:443#国家-住宅-01$sstp://vpn:vpn@节点:端口`。edgetunnel 下次生成订阅时会 fetch 这个网址、逐行解析成优选入口 + 链式代理指令。你只填一次，之后节点每 30 分钟自动换、零手动。

---

## 三、如何更换优选域名

入口地址用的是「优选域名」，决定客户端连 Cloudflare 用哪个 IP、稳不稳。

### 在哪个文件改
- 文件：vpngate.py
- 位置：`EDGE_HOSTS = [ ... ]`

### 改法
1. 用测速工具（如 bestcf）测一批 Cloudflare 优选域名，挑「延迟低 + 实际能连通」的
2. 打开 vpngate.py，把 `EDGE_HOSTS` 里的域名列表换成你测出来的（逗号分隔，格式 `域名:443`）
3. 提交推送，等下一次自动运行或手动触发 Action

---

## 四、配置速查表（vpngate.py）

| 常量 | 说明 |
| :--- | :--- |
| `EDGE_HOSTS` | 入口优选域名（换域名改这里） |
| `WORKER_CHECK_URL` | 检测 Worker（本地运行默认值，Action 里用 workflow 的 `CHECK_WORKER` 覆盖） |
| `NODES_URL` | 自动更新时用到的固定地址（fork 后改成你自己的） |

> 再次强调：`vpngate.py` **不需要**配置 `EDT_UUID` 和 `EDT_DOMAIN`，这两个参数属于 edgetunnel 本身。

---

## 五、常见问题

### 只有几个节点能连
入口优选域名大部分被墙。用 bestcf 重新测速，把 `EDGE_HOSTS` 换成实测能通的域名。

### 全部 -1
检查：edgetunnel 是否部署好、域名是否解析到 Cloudflare、UUID 是否填对、传输协议是否对得上。

### 30 分钟没更新
到 Actions 页看最近一次运行是否成功、cron 是否还在。

### 检测 Worker 报错
确认 Worker 部署成功、域名填对（workflow 里的 `CHECK_WORKER`），浏览器直接访问 `https://你的Worker/check?sstp=...` 看是否返回 JSON。

### 不知道 UUID 和节点域名在哪里看
登录 edgetunnel 后台（`https://你的域名/admin`），在后台首页就能看到。

---

*流水线：GitHub Actions（每 30 分钟 cron） → vpngate.py → 检测 Worker → Cloudflare Pages / GitHub Pages*

---

## 引用与致谢

本项目的实现离不开以下开源项目和服务的支持，在此表示衷心的感谢：

| 项目 | 用途 | 链接 |
| :--- | :--- | :--- |
| **cmliu/edgetunnel** | VLESS 代理 + 链式代理，节点最终通过它使用 | https://github.com/cmliu/edgetunnel |
| **lsh8848/cm-Workers-CheckSocks5** | 检测 Worker：验证 SSTP 节点可用性并读取出口 IP | https://github.com/lsh8848/cm-Workers-CheckSocks5 |
| **fdciabdul/Vpngate-Scraper-API** | VPN Gate 节点数据的 GitHub 镜像（官方源失效时回退） | https://github.com/fdciabdul/Vpngate-Scraper-API |
| **VPN Gate** | SSTP 节点数据源 | https://www.vpngate.net/ |
| **Star History** | 提供项目热度曲线图生成服务 | https://star-history.com/ |

---

## 项目热度

[![Star History Chart](https://api.star-history.com/svg?repos=hezhanleiok/gate&type=Date)](https://star-history.com/#hezhanleiok/gate&Date)

---

**特别感谢**：
感谢所有为开源社区做出贡献的开发者们！没有你们的无私奉献，就没有这个项目的诞生。也感谢每一位使用、测试和反馈问题的用户，是你们的支持让这个项目不断完善。
