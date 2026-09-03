# SaaS Store CF

基于 Cloudflare Workers 的轻量 SaaS 产品展示购买系统：可视化编辑落地页，管理产品与套餐，通过支付宝 / 微信支付收款，支付成功后异步通知你的业务系统。

单管理员后台，不做 RBAC / 多租户；全部运行在 Cloudflare 免费可用套餐的组件上（Workers + D1 + R2 + Queues），无传统服务器。

## 功能特性

- **可视化页面编辑**：基于 [Puck](https://puckeditor.com/) 的 17 种区块（Hero、特性、价格表、FAQ、对比表等），草稿与发布分离，支持版本快照与回滚。
- **产品与套餐管理**：套餐价格由后台统一配置，页面 Pricing 区块实时读取，不重复保存金额。
- **支付宝网站支付**：PC 走电脑网站支付（`alipay.trade.page.pay`），手机浏览器自动切换手机网站支付（`alipay.trade.wap.pay`），异步通知 RSA2 验签。
- **微信支付（API v3）**：PC 使用 Native 扫码支付，手机浏览器使用 H5，微信内支持公众号 JSAPI 支付（网页授权获取 OpenID、直接调起收银台）；支持退款与退款回调。
- **订单运营**：主动对账同步、超时关单、部分退款 / 全额退款、批量查询 / 关闭 / 删除，以及异常订单的单笔 / 批量强制删除。
- **对外 Webhook**：支付成功后经 Cloudflare Queue 投递，HMAC-SHA256 签名、指数退避重试、投递日志与手动重发。
- **R2 素材库**：图片上传与页面区块绑定。
- **AI 内容助手**（基于 Cloudflare Workers AI）：产品文案、页面区块文案、SEO 元信息与图片 alt 中文描述一键生成；内置每日 9,900 Neurons 硬护栏，永不超出免费额度。
- **站点视觉配置**：主题色、字体、布局、全局 Header/Footer，实时预览。
- **SEO 与站点优化**：服务端注入页面标题、描述、关键词、Open Graph、规范链接与结构化数据（百度等不执行脚本的搜索引擎也能正确抓取）；自动生成 robots.txt 与 sitemap.xml；页面级关键词与 noindex；ICP 备案与版权展示；支持接入百度统计 / Google Analytics 等自定义代码。

## 架构与技术栈

| 层 | 技术 |
|---|---|
| 运行时 | Cloudflare Workers（`nodejs_compat`） |
| 数据库 | Cloudflare D1（SQLite），`migrations/` 管理结构变更 |
| 对象存储 | Cloudflare R2（素材库） |
| 异步任务 | Cloudflare Queues（Webhook 投递，指数退避重试） |
| 前端 | React 19 + Ant Design 6 + Puck 可视化编辑器 + Vite |
| 密码学 | 全部使用 WebCrypto 原生 API（RSA2/AES-GCM/HKDF/HMAC），零第三方加密依赖 |

```
.
├── worker/                  # Cloudflare Worker 后端
│   ├── index.ts             # 入口：fetch / queue 处理器与路由分发
│   ├── http.ts              # 通用 HTTP 与工具函数
│   ├── site-settings.ts     # 站点主题 / Header / Footer 设置归一化
│   ├── routes/              # auth / admin / public / media 路由
│   ├── orders/              # 订单生命周期与退款
│   ├── payment/             # 支付宝 / 微信支付协议与渠道适配
│   ├── webhook/             # 对外 Webhook 投递
│   ├── auth/                # 管理员会话
│   ├── crypto/              # 加密与编码工具
│   └── db/                  # D1 设置读写
├── src/                     # React 前端（公开站点 + /admin 后台）
├── migrations/              # D1 数据库迁移
├── scripts/ci/              # GitHub Actions 辅助脚本
└── .github/workflows/       # Deploy workflow
```

## 部署（GitHub Actions，推荐）

与 [cloud-mail](https://doc.skymail.ink/guide/action.html) 的 Action 部署方式相同：Fork 仓库 → 配置 Secrets → 运行 workflow，D1 / R2 / Queue 由 Cloudflare 自动资源预配按名创建，无需手动填写任何资源 ID。

### 1. Fork 仓库

Fork 本仓库到你的 GitHub 账号。

### 2. 创建 Cloudflare API Token

1. 打开 [Cloudflare Dashboard → My Profile → API Tokens](https://dash.cloudflare.com/profile/api-tokens)，点击 **Create Token**。
2. 使用模板 **Edit Cloudflare Workers**，在模板权限基础上追加：
   - `D1` → **Edit**（创建数据库、应用迁移）
   - `R2` → **Edit**（自动创建素材桶）
   - `Queues` → **Edit**（自动创建 Webhook 队列）
3. Account Resources 选择你的目标账户，创建并复制 Token。
4. 在 Cloudflare Dashboard 首页右侧复制 **Account ID**。

### 3. 配置 GitHub Secrets

在 Fork 后的仓库 **Settings → Secrets and variables → Actions → Repository secrets** 添加：

| Secret | 说明 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | 上一步创建的 API Token |
| `CLOUDFLARE_ACCOUNT_ID` | 你的 Cloudflare Account ID |
| `ADMIN_USERNAME` | 管理后台登录账号 |
| `ADMIN_PASSWORD` | 管理后台登录密码（至少 10 位） |

`SETTINGS_ENCRYPTION_KEY` 不需要配置：首次部署时自动生成并保存为 Cloudflare Secret，后续部署自动沿用（它用于加密后台保存的支付密钥，请勿删除或轮换）。

### 4. 运行部署

推送到 `main` 分支自动触发，或在 **Actions → Deploy → Run workflow** 手动触发。workflow 会依次执行：构建 → `wrangler deploy` → 写入管理员凭据与加密密钥 → 应用 D1 迁移。首次运行约 2-3 分钟。

### 5. 部署后初始化

1. 打开 `https://<worker 域名>/admin`，使用配置的管理员账号密码登录。
2. **系统设置 → 网站**：设置站点名称和正式主域名（用于生成支付回调地址，建议填写）。
3. **系统设置 → 支付宝支付 / 微信支付**：填写商户参数并启用（见下文支付配置）。
4. **系统设置 → Webhook**：填写业务系统 URL，生成 Secret，选择订阅事件。
5. **产品与套餐**：创建产品和价格。
6. **页面**：编辑默认首页并发布。

## 本地开发

需要 Node.js 22.15+（推荐最新 Node.js 22 或 24）。

```bash
git clone <你的仓库>
cd saas-store-cf
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

> 本地 dev 需要能访问 Cloudflare 远程会话（AI 助手的 Workers AI binding 在本地也走云端推理）：首次运行前执行 `npx wrangler login`，或在环境变量中提供 `CLOUDFLARE_API_TOKEN`。不登录时 dev server 无法启动。

`.dev.vars` 内容：

```dotenv
ADMIN_USERNAME=admin
ADMIN_PASSWORD=change-this-password
SETTINGS_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
```

访问 `http://localhost:5173/admin`。本地开发用的支付回调需要内网穿透才能收到，建议直接在部署环境联调支付。

常用脚本：

| 命令 | 说明 |
|---|---|
| `npm run dev` | 本地开发（Vite + Worker） |
| `npm run build` | 类型检查 + 生产构建 |
| `npm run test:ai` | AI 响应与用量结算回归测试 |
| `npm run test:payment` | 微信支付签名、网页授权、支付分流和 JSBridge 回归测试（模拟微信接口，不发起真实交易） |
| `npm run test:orders` | 普通 / 强制删除订单、关联记录清理、批量结果及管理员权限回归测试 |
| `npm run db:migrate:local` | 应用本地 D1 迁移 |
| `npm run db:migrate:remote` | 应用远程 D1 迁移 |

## 支付配置

所有支付参数在 `/admin` 后台录入，敏感项（私钥、APIv3 密钥、Webhook Secret）以 AES-256-GCM 加密存储于 D1。

### 支付宝网站支付（电脑 + 手机 H5）

在 **系统设置 → 支付宝支付** 填写：

- **AppID**：开放平台应用 AppID
- **应用私钥**：与该 AppID 的应用公钥匹配的 RSA2 私钥（PKCS1 / PKCS8 均可）
- **支付宝公钥**：支付宝开放平台返回的支付宝公钥
- **商户 PID**：可选，填写后增强回调校验（校验 `seller_id`）
- **网关**：默认 `https://openapi.alipay.com/gateway.do`

无需额外配置即可覆盖两种场景，系统按访客设备自动切换：

| 设备 | 接口 | product_code |
|---|---|---|
| PC 浏览器 | `alipay.trade.page.pay` | `FAST_INSTANT_TRADE_PAY` |
| 手机浏览器 | `alipay.trade.wap.pay` | `QUICK_WAP_WAY`（含 `quit_url` 中途退出回跳） |

请确认已在支付宝开放平台签约「电脑网站支付」与「手机网站支付」两个产品。回调地址：`https://<你的域名>/api/payment/alipay/notify`，两者共用。

### 微信支付（Native 扫码 + H5 + JSAPI）

在 **系统设置 → 微信支付** 填写：

- **AppID**：与商户号绑定的公众号 / 小程序 / 开放平台应用 AppID
- **启用微信内支付（JSAPI）**：默认关闭；开启时上方 AppID 必须是支持 JSAPI 支付的已认证公众号 AppID
- **公众号 AppSecret**：JSAPI 网页授权使用，与上方公众号 AppID 配套；加密保存在服务端，留空不修改已保存值
- **商户号（mch_id）**
- **商户证书序列号**：商户平台 → API 安全 → 商户证书序列号
- **APIv3 密钥**：32 位字符，用于回调报文解密与平台证书下载
- **商户私钥**：`apiclient_key.pem` 的完整内容，用于 API 请求签名
- **微信支付公钥 / 公钥 ID**：可选；公钥模式商户填写（回调 `Wechatpay-Serial` 以 `PUB_KEY_ID_` 开头时使用），平台证书模式商户可留空，系统会自动下载并缓存平台证书

请在微信支付商户平台开通所需的 **Native 支付**、**H5 支付**、**JSAPI 支付** 产品。支付结果通知共用 `https://<你的域名>/api/payment/wechat/notify`，由系统自动生成。

如通过 CDN / 反向代理访问，且回源时改写了域名，需要在 `wrangler.jsonc` 的 `vars.WECHAT_PAYMENT_TRUSTED_ORIGINS` 中列出浏览器实际访问的来源，例如 `["https://test.smallds.icu"]`。每项仅含协议、主机和非默认端口，不带路径或末尾斜杠；修改后重新部署。该名单仅用于微信下单接口的来源校验，使用精确匹配；其他域名、`Origin: null` 和未经配置的代理请求头不会被放行。它不替代微信商户平台的 H5 域名、公众号网页授权域名等配置。

JSAPI 上线配置：

1. 完成公众号与商户号的授权绑定，在后台填写公众号 AppID、AppSecret，并打开「启用微信内支付（JSAPI）」。
2. **系统设置 → 网站**：填写正式 HTTPS 主域名，例如 `https://shop.example.com`。
3. **微信公众平台**：将 `shop.example.com` 配置为公众号的网页授权域名（仅域名，不带协议和路径），并按平台要求完成域名验证。系统的授权回调地址为 `https://shop.example.com/api/payment/wechat/oauth/callback`。
4. **微信支付商户平台**：配置 JSAPI 支付授权目录为 `https://shop.example.com/payment/`（保留末尾斜杠）。所有微信内调起支付都在 `/payment/result` 页面完成。
5. 部署时应用 `0008_wechat_jsapi.sql` 数据库迁移；现有 GitHub Actions 会自动应用。本地开发执行 `npm run db:migrate:local`。

结账流程：访客选择套餐 → 填写联系方式 → 选择支付方式。PC 展示二维码，手机外部浏览器跳转 H5，微信内进入结果页，通过 `snsapi_base` 网页授权获取 OpenID 后调起 JSAPI 收银台。授权往返和取消后重试均沿用同一笔订单，不会重复创建订单。未开启 JSAPI 时，微信内展示二维码。

OpenID 仅从服务端授权响应获取，不接受前端传入的 OpenID；网页授权状态绑定浏览器与订单、10 分钟有效且只能使用一次。短期 OpenID 会话使用加密的 HttpOnly / Secure Cookie，前端不会获得 AppSecret 或授权 access_token。支付成功仍以服务端查单或验签后的异步通知为准，前端收银台回调不会直接修改订单状态。

上线后需在真实微信客户端验证授权、调起、取消重试及支付回调。配置要求参见[微信支付接入准备](https://pay.wechatpay.cn/doc/v3/merchant/4015423216)，调起方式参见[JSAPI 调起支付](https://pay.wechatpay.cn/doc/v3/merchant/4012791857)。

## SEO 与站点优化

可视化编辑器内置 25 个区块组件（基础 / 营销 / 商业三类），全部默认文案为中文；页面模板与组件内容开箱即中文。

**服务端 SEO 注入**：Worker 接管页面请求，在返回 HTML 时注入 `<title>`、`description`、`keywords`、Open Graph、`canonical`、`robots` meta 与 WebSite 结构化数据（JSON-LD）——无需浏览器执行脚本，百度、搜狗等搜索引擎可直接抓取。静态资源原样透传。

**站点级配置**（`/admin` → 系统设置 → SEO 与优化）：

- 允许搜索引擎收录开关（关闭后 robots.txt 禁止全部抓取）
- 全站默认关键词与默认分享图
- ICP 备案号与版权文案（显示在页脚，备案号自动链接工信部网站）
- 自定义 Head / Body 代码（用于接入百度统计、Google Analytics、站长验证等）

**页面级配置**（可视化编辑器 → 页面设置）：SEO 标题、描述、关键词、OG 分享图、禁止收录（noindex）开关；发布前检查会提示缺失的 SEO 项。

**自动生成文件**：

- `https://<你的域名>/robots.txt` —— 按收录设置生成，并声明站点地图
- `https://<你的域名>/sitemap.xml` —— 自动列出所有已发布且未禁止收录的页面

## AI 内容助手（Workers AI）

在 **系统设置 → AI 助手** 中启用后（默认关闭），后台提供四类中文内容生成，全部仅管理员可触发：

| 功能 | 位置 | 说明 |
|---|---|---|
| 产品文案 | 产品编辑弹窗 | 输入卖点 → 生成一句话介绍与详细介绍 |
| SEO 元信息 | 页面编辑器 → 页面设置 | 基于页面草稿生成 SEO 标题 / 描述 / 关键词 |
| 区块文案 | 页面编辑器 → ✨ AI 区块文案 | 为 Hero / Features / FAQ / Text / CTA 生成字段内容，可复制或追加到草稿 |
| 图片描述 | 素材库 → ✨ 生成 alt | 视觉模型为 R2 图片生成中文替代文字 |

**免费额度硬护栏（代码级，不可调高）**：

- 每日上限 **9,900 Neurons**（免费额度 10,000/天，留 1% 余量），写在 `worker/ai.ts` 中；
- 每次调用先按**保守上界**（输入按 1 字 ≈ 2 token 放大、含 max_tokens 上限、×1.5 安全系数）通过 D1 条件更新**原子预留**额度，调用后按响应 `usage` 的实际 token 结算回扣——累计消耗在数学上不可能超过上限；
- Workers Free 计划永不触顶报错，Workers Paid 计划永不产生 AI 账单；额度每天 UTC 0 点重置；
- 默认模型为 Llama 3.1 8B FP8 Fast（约 21 Neurons / 次生成），可在后台切换 Llama 3.3 70B Fast（约 123 Neurons / 次）；图片描述使用 Llama 3.2 11B Vision（每张预留 150 Neurons）；
- 后台「AI 助手 → 今日用量」实时展示已用 Neurons 与调用次数。

无需任何 API Key：Workers AI 以 binding 形式随 Worker 自动可用（`wrangler.jsonc` 中的 `ai` 绑定）。

## 支付链路

```text
创建本地订单（幂等：Idempotency-Key / checkout_request_id 唯一索引）
  → 支付宝 alipay.trade.page.pay 收银台 / 微信 Native code_url 二维码 / 微信 H5 跳转
  → 渠道异步回调（支付宝 RSA2 验签 + 金额校验；微信平台证书验签 + APIv3 报文解密 + 金额校验）
  → orders.status = paid（状态机 CAS 更新，防并发重复标记）
  → Cloudflare Queue
  → 对外业务 Webhook
```

- `/payment/result` 只展示并轮询本地订单状态，不根据浏览器回跳判定支付成功。
- 订单状态查询接口会节流（30 秒）触发渠道主动对账（支付宝 `trade.query` / 微信查单），回调未到达也能自动收敛状态。
- 待支付订单 30 分钟未支付自动关闭（支付宝 `trade.close` / 微信关单）。

后台订单列表支持“强制删除”和“批量强制删除”（每次最多 20 条），确认后可删除任意状态的异常订单，适用于订单号错误、渠道无法查单或关单等情况。该操作永久删除本系统订单及关联退款记录、微信授权状态；不会调用支付渠道关闭交易或退款，渠道交易仍需在微信 / 支付宝商户平台处理。删除后本系统无法继续处理该订单的支付及退款通知，已支付订单删除后也会从后台营收统计中移除。普通删除仍保留原有状态限制。

## 对外 Webhook

事件类型：`order.created`、`order.paid`、`order.closed`、`order.refunded`。

请求头：

```text
X-Webhook-Id
X-Webhook-Timestamp
X-Webhook-Signature: sha256=...
```

签名原文为 `<timestamp>.<raw-json-body>`，算法 HMAC-SHA256。接收方校验示例（Node.js）：

```js
const expected = "sha256=" + crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("base64");
if (expected !== signature) return res.status(401).end();
```

使用 `event.id` 做幂等。投递失败自动重试（30s 起指数退避，上限 1 小时，最多 8 次），可在后台 Webhook 日志中查看投递记录并手动重发。

## 安全说明

- **管理员会话**：HMAC 签名 Cookie（HttpOnly / Secure / SameSite=Lax，12 小时），会话密钥由管理员账号密码经 HKDF 派生——修改 `ADMIN_PASSWORD` 即吊销所有旧会话。
- **敏感配置加密**：支付宝私钥 / 微信 APIv3 密钥与私钥 / Webhook Secret 使用 AES-256-GCM 加密存储，密钥由独立 Secret `SETTINGS_ENCRYPTION_KEY` 经 HKDF 派生，与管理员密码无关。
- **CSRF**：所有写操作校验 `Origin` 同源。
- **注入防护**：主题值、页面链接白名单校验；R2 读取拦截路径穿越；Webhook URL 强制 HTTPS。
- **支付校验**：回调验签 + AppID/商户校验 + 订单金额比对 + 状态机 CAS 更新；退款先预占额度防超退。

> 不要删除或重新生成 `SETTINGS_ENCRYPTION_KEY`；如果丢失该 Secret，后台已保存的敏感设置将无法解密，需要重新录入。

## 参考文档

- [Cloud Mail 的 Action 部署说明（本项目的部署方式参照）](https://doc.skymail.ink/guide/action.html)
- [Wrangler 自动资源预配](https://developers.cloudflare.com/changelog/post/2025-10-24-automatic-resource-provisioning/)
- [支付宝电脑网站支付文档](https://opendocs.alipay.com/open/270/105899)
- [微信支付 API v3 Native 支付](https://pay.weixin.qq.com/doc/v3/merchant/4012791882)
- [微信支付退款回调通知](https://pay.weixin.qq.com/doc/v3/merchant/4012791886)
