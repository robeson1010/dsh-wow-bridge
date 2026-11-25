# 魔兽世界工作区：DSH Chat 桥接

这个文件夹是《魔兽世界：无限》（WoW Forever，客户端目录 `World of Warcraft/_forever_`，Interface 16001）
游戏内 **[DSH] 聊天频道**的全部代码：玩家在游戏聊天框里提问，由这台电脑上的 dsh web 回答。用法见 `README.md`。
作者署名：加拿大雨姐。

## 数据怎么走

```
游戏插件 dsh-web/addon/DSHChat（Lua）
  → C_VoiceChat.SpeakText 音量 0，对静音语音 "DSHBridge" 朗读 "DSHB:<id>:<i>/<n>:<base64 JSON>"
  → dsh-web/voice/DSHBridgeTts.cs（SAPI 引擎，在 Wow.exe 进程里）推到命名管道 \\.\pipe\DSHBridge
    （没人监听时写到 %APPDATA%\DSHBridge\tts-inbox\*.txt）
  → dsh-web/index.js（dsh web 里的 Host 插件）：每个角色一个会话，预设 wowf（只读魔兽资料工具、审批 never）
    预设 wowf 查资料：无限图鉴 MCP（wuxianwow.com/mcp）、web_search、web_fetch（魔兽网站白名单）；
    价格只从网上查，按设置页的服务器（lib/settings.mjs）：欧服、美服用 wowauctions.net（.../forever-<eu|us>/<规则集>-forever-<eu|us>/<阵营>/x-<物品ID>），
    国服用无限图鉴的 auction_house（house = <规则集>-<阵营>）；不用本机插件数据
  → 回答写成字体文件 Interface\AddOns\DSHChat\mail\NNNNN.ttf（字形宽度 = 字节，dsh-web/lib/fontmail.mjs + ttf.mjs）
  → addon 的 Mailbox.lua/Font.lua 量字宽读回，Core.lua 打印到聊天框
```

| 位置 | 内容 |
| --- | --- |
| `dsh-web/addon/DSHChat/` | 游戏插件（dsh web 启动时由 `dsh-web/lib/setup.mjs` 自动装进游戏）。`Core.lua` 频道、提问、物品链接、回答渲染、地图位置（`{{loc:…}}`/`{{npc:…}}` → 游戏自带地图标记的 worldmap 链接）、采购清单（回答里的 `{{buy:…}}` 先列在聊天框，玩家点 [加进 Auctionator]、`/dshc buy`、菜单或在问题里要求后才进 Auctionator 购物清单「DSH 采购」）、`/dshc`（子命令表 `Core.commands`）；`Voice.lua` 上行；`Font.lua`/`Mailbox.lua` 回信；`QuickMenu.lua` 快捷提问按钮和菜单（Blizzard_Menu）；`Bindings.xml` 两个快捷键（客户端自动加载，不写进 TOC） |
| `dsh-web/voice/` | 静音语音引擎 C# 源码和安装脚本（设置页的“安装静音语音”跑它：弹 UAC，再完整重启游戏） |
| `dsh-web/` | dsh web 组合包 `@local/dsh-wow-bridge`：`index.js` 桥接服务和设置页接口（`/api/wow-dsh-bridge/*`，DSH 的 connection 精确路由，只有本机主人能访问），`client.js` 设置页（手写的 lazy-CJS 工厂格式，React 用 `require('react').createElement`，挂在插件页的 `plugins.bundle.config`），`cordis.patch.yml` 插件配置 + 预设 `wowf`（人设在 `prefix`），`wowf-tool-policy.js` 工具白名单，`wowf-market-tools.js` + `wowauctions.js` 行情/制作利润工具，`vendors.js` 查商人卖不卖 |
| `dsh-web/lib/` | 共用代码（管道、游戏进程跟踪、字体回信、提问格式 `answer.mjs` 的 `prompt()`、`setup.mjs` 找游戏目录 + 装游戏插件）。组合包必须自成一体：不准从 `dsh-web/` 外面 import 或读文件 |
| `bridge/bridge.mjs` | 不依赖 dsh web 的独立桥接（备用；每题启动一次 headless profile `wowf`） |
| `test/` | `e2e_offline.py`（插件 Lua + 独立桥接 + 模拟客户端）、`web_plugin_offline.mjs`（插件 + 假 DSH 宿主 + 设置页接口）、`setup_offline.mjs`、`wowf_policy_offline.mjs`、`market_offline.mjs`、`web_live_drive.mjs` |

## 必须遵守的规则

1. **`dsh-web/index.js` 跑在 dsh web 进程里，任何未捕获的异常或未处理的 Promise 拒绝都会让整个 dsh web 退出。**
   每个事件、定时器、管道、fs.watch 回调都要 try/catch；每个不 await 的 Promise 都要 `.catch`；不准 `process.exit`；
   `apply()` 里不准 await DSH 服务（预设注册可能等整个加载树，会卡死启动），会话一律懒创建。
2. **人设（`prefix`）里不准出现两个连续的左花括号**：那是 DSH 的模板语法，写错会让这个模式每次请求都报错。
   `{{item:ID|名字}}`、地图位置（`MAP_RULE`）和采购清单 `{{buy:标题|ID×数量,…}}`（`BUY_RULE`）这几条格式规则放在用户消息里
   （`dsh-web/lib/answer.mjs` 的 `prompt()`），用户消息不做模板替换。为省 token，规则和服务器说明**只放在每个会话的第一条消息**
   （`prompt(req, {rules})`，插件看 `web-sessions.json` 里的 `turns === 0`），之后的消息只带一行 `RULES_REMINDER`。
3. **预设 `wowf` 只准有只读的魔兽资料工具**：游戏里的文字（任务名、物品提示、玩家问题）是不可信输入。
   `dsh-web/wowf-tool-policy.js` 是边界：guard 只放行 web_search、web_fetch（白名单 wowhead.com、wuxianwow.com、
   warcraft.wiki.gg、wowpedia.fandom.com、icy-veins.com、wowauctions.net 及子域名）
   我们自己的 `wow_item_market`、`wow_craft_profit`（`OWN_TOOLS`）和 `MCP_TOOLS` 里的 15 个无限图鉴工具；文件、命令、worktree、MCP 资源、report_issue、导演台/视频工具都隐藏并拒绝执行。
   每个工具的说明在每次模型调用里都要发（2026-11-20 的 31 个工具约 2 万 token/次）：加工具前先想清楚值不值。
   无限图鉴的结果在 `tools/post-execute` 里瘦身（去掉每次都一样的数据说明 `note`/`*_note`、空值、item_usage 的国服拍卖块，
   超过 8000 字只留头尾），只改模型看到的内容、不改工具返回值。
   新工具必须先进白名单；无限图鉴 MCP 只能挂在预设里，不准放进 mcp-manager（否则所有模式都看得到）。
   不准绕过 Cloudflare/CloudFront 验证，不准把 User-Agent 改成浏览器：Wowhead 的 /forever/ 页面 403，读不到就用搜索摘要。
   价格只从网上查（用户要求），不读本机 Auctionator 的价格（插件只往 Auctionator 写购物清单）。来源跟设置页的服务器走（用户要求 2026-11-22）：
   欧服、美服 → wowauctions（我们的两个工具，无限图鉴拍卖价只能当“国服参考价”，`auction_house` 隐藏并拒绝）；
   国服 → 无限图鉴 `auction_house`（我们的两个工具隐藏并拒绝，item_usage 的拍卖块保留）。服务器和价格来源写在每个会话第一条消息的“服务器：”一行
   （`answer.mjs` 的 `serverLine()`），人设里不写具体服务器；改了服务器或阵营，`store.rollAll()` 让每个角色下一个问题开新会话，
   并发 `wow-dsh-bridge/settings` 事件让工具策略重新隐藏。
   `fetchMaxOutputChars` 也是转换前原始 HTML 的截断长度：wowauctions 的价格在 HTML 第 2 万字符左右，不能调回 16000 以下。
   行情工具解析页面里的 `__NEXT_DATA__` JSON（不是可见文字）；网站改版后先看 `test/market_offline.mjs` 是否还过。
   wowauctions 的 `api.wowauctions.net` 没有公开文档，不准用；同一页面 30 分钟内只读一次。
   **商人卖不卖不准看 wowauctions**：它的 `available_from_vendor` 对每件物品都是 true（符文布、瑟银锭也是），专业页材料的 `price_source` 全是 ah，
   0.5.2 以前就因此把拍卖行材料说成商人有卖。现在由 `vendors.js` 调无限图鉴 `item_usage` 的 `temporary_vendors`（玩家在无限服记下的商人货单，临时数据，
   回答要注明无限图鉴和“临时”）：通用商品（`common` 或 5 个以上商人）才算“商人有卖”、不进采购清单；一两个商人的（常常限量或要声望，
   如冬泉谷维尔的魔纹布）标“少数商人有”，照常算拍卖行材料。查不到时只认 `VENDOR_REAGENTS` 这张备用表，其余说“没查到”，不准猜。
   结果缓存 12 小时（失败 2 分钟），最多 4 个并发；人设里也写了“卖店价不代表商人卖它”。
4. 改了 `dsh-web/` 里的代码后要**重启 dsh web**（热重载不看这些源文件）。改人设后再在游戏里 `/dshc reset`，
   已有会话保留旧人设。
   **token 用量**（实测 2026-11-21：每题约 13 万 token，未缓存 4.3k，输出 660 其中约八成是思考）：插件给游戏会话选
   `cordis.patch.yml` 里的 `model`（deepseek-flash，思考强度 low；新旧会话都选，预设本身设不了思考强度）；
   会话答满 `maxTurns`（12）轮或上一次提示达到 `rolloverTokens`（45000）就开新会话，新会话第一条消息带规则和上段对话最后一问一答。
   DSH 的自动压缩要到约 68 万 token 才触发，等于不会触发，别指望它。每轮的 token 用量记在 `web-bridge.log`。
5. **独立桥接 `bridge/bridge.mjs` 不能和 dsh web 插件同时开**（抢同一个管道和收件夹）。
6. 游戏插件：**新增文件**要完整重启游戏才看得到（游戏只在启动时发现文件）；只改已有文件 `/reload` 就行。
   安装/同步：dsh web 启动时插件自动做（`lib/setup.mjs` 的 `syncAddon`：游戏开着只覆盖已有文件，新文件和槽位等游戏退出）。
   改游戏插件就改 `dsh-web/addon/DSHChat/`：游戏目录里的副本会被同步覆盖。
   找游戏目录：`%APPDATA%\DSHBridge\config.json` 的 `addons`/`wowDir`（设置页写），否则 Battle.net 的 product.db 和卸载项，再否则常见目录。
   **第一次安装只在玩家点设置页的“安装游戏插件”时做**（用户要求：装好 DSH 插件后自己设置）；装过以后每次启动/升级自动同步。
   `cordis.patch.yml` 里不准写本机路径（这台电脑的设置都在 config.json）。不用 dsh web 时：游戏关闭时 `node bridge/bridge.mjs install`。
   回信槽位 `mail\00001..01024.ttf` 和 `proc.ttf` 必须在游戏启动前就存在，游戏运行时不要删。
7. 回答是不可信文字：插件把 `|` 转义成 `||`，只有 `{{item:ID|名字}}` 会变成链接，而且只用玩家自己发的链接或名字对得上的客户端链接。
   `{{buy:…}}` 只会变成 Auctionator 购物清单（物品名取自客户端，最多 12 种、每种最多 1000 个），而且**用户要求不自动加**：
   只有玩家确认（点链接、`/dshc buy`、菜单）或在问题里要求（`Core.AskedToAdd`）才加。**不准加任何自动购买、自动按键的功能**：
   购买必须是玩家自己在拍卖行点（暴雪也要求硬件事件），用户已经明确不要外挂式的自动操作。
   **除“打字提问”明确点选频道后的诊断性切换，插件不准打开、填写或改暴雪的聊天框**（`ChatFrameUtil.OpenChat`、编辑框的 `SetChatType`/`SetTellTarget`/`SetChannelTarget`/`SetText`、
   `ChatFrameUtil.InsertLink` 之类）：聊天类型和对象是编辑框属性，插件写过就被污染，玩家下一句真话读到它，受限的
   `C_ChatInfo.SendChatMessage` 被拦（“DSHChat has been blocked from an action only available to the Blizzard UI”），
   而且污染的类型会变成固定频道，之后每一句都被拦（0.5.0 的 [填入聊天框] 和菜单的 OpenChat 就是这样，0.5.2 改掉）。
   “打字提问”只在玩家点选 `/DSH`、`/S`、`/P`、`/G` 时调用一次 `ChatFrameUtil.OpenChat`，由玩家自己输入正文和按回车。`/dshc chatdiag` 查看最近一次切换及受限操作事件。翻译由玩家手动打 `/dsht`，复制译文用 `Core.ShowCopy`（选中后 Ctrl+C）。
   预发送回调 `ChatFrame.OnEditBoxPreSendText` 对真实频道的消息什么都不读不写，只处理 DSH/DSHT 两个类型。
   聊天框里的 `|Haddon:DSHChat:buy:N|h` 链接由暴雪的 addon 链接处理器转给 `EventRegistry` 的 "SetItemRef"（Forever 的 ItemRefHandlersShared.lua）。
   地图位置同样**不自动标**：渲染成暴雪原生的 `|Hworldmap:uiMapID:x*100:y*100|h` 链接，点了由暴雪自己的处理器放地图标记（不经过我们的代码，没有污染）。
   只有问题里要求（`Core.AskedToMark`）才由插件调 `C_Map.SetUserWaypoint` 标第一个位置，而且战斗中、地图开着时不调
   （USER_WAYPOINT_UPDATED 是同步事件，暴雪的地图代码会以插件身份运行）；调用前后临时注销/恢复地图上
   `WorldMapTrackingPinButton` 的这个事件（地图关着时它是唯一一直在听的暴雪监听者）。不要用 `C_SuperTrack` 或打开地图。
   `AskedToMark` 只认请求说法，句子里有否定词就不标，“目标/坐标”这类带“标”的词先去掉。
   NPC 位置读 QuestieDB 的公开 API（`NpcDB.spawns/name`），区域换算用 Questie 内部的 `ZoneDB:GetUiMapIdByAreaId`（都要 pcall、要判断函数存在）。
8. 保留 `THIRD_PARTY_NOTICES.md`：语音、字体回信的代码改编自 Forever AI Companion 和 无限工坊（MIT）。

## 升级

- 仓库在 GitHub（`dsh-web/package.json` 的 `repository`，`directory: dsh-web`）。DSH 只能把“从 Git 固定提交装的”组合包升级到另一个固定提交
  （`git+https://github.com/<owner>/<repo>.git#<40 位提交号>&path:/dsh-web`），而且 Git 包没有版本列表，所以 `lib/update.mjs` 自己查：
  `main` 的最新提交 + 那个提交的 `dsh-web/package.json` 版本号，比现在的版本新就调 DSH 的 `pluginManager.updateBundle`。
- 每 6 小时查一次（设置页打开时也查），`autoUpdate`（默认开）时在后台装好但**不自动重启**（dsh web 里可能有别的任务在跑）；
  玩家点“升级到 x”时装好后自动重启。正在回答问题时不升级、不重启。开发用的本地链接（`link:`）不会被升级。
- 重启（`lib/restart.mjs`，参考 dsh-pocket 的做法自己写的）：起一个分离的 node 助手进程，等 dsh web 的端口空出来再用同一条命令行
  重新启动 dsh web（后台运行，输出在临时目录 `dsh-wow-bridge-restart-*.log`），旧进程随后退出。DSH 桌面版（Electron）不做。
- **插件不准自己建 DSH 工作区**：0.5.0 每次启动都注册“魔兽世界无限服”，玩家删了又冒出来。现在只用设置页选的已有工作区（config.json `workspaceId`），
  启动时把以前在 `<dataDir>\workspace` 注册的那个移除一次（移除工作区不删对话和文件）。
- **Claude 桌面版是打包应用**：在它里面跑的工具往 `%APPDATA%` 写文件会被 Windows 重定向到 `%LOCALAPPDATA%\Packages\Claude_…\LocalCache\Roaming`，
  dsh web 看不到。要改 config.json 就让用户在设置页里改，别从这里直接写。
- `%APPDATA%\DSHBridge\update.json` 记着装好的新版本：运行中的版本比它旧就在设置页显示“重启 dsh web”；新版本起来后显示一次“已升级到 x”并删掉它。
- 设置页挂两处：`settings.section`（设置里的一级入口“魔兽世界”，dsh-pocket 也是这样）和 `plugins.bundle.config`（插件详情页）。
  dsh-pocket 是 GPL-2.0：只参考做法，不准抄它的代码（本仓库是 MIT）。
- **发版就是改版本号再推到 main**：`dsh-web/package.json` 的 `version`（必须比上一版大，semver）和 `DSHChat.toc` 的 `## Version`。
  推之前全部测试要过：推上去的东西几小时内就会装到所有人的电脑上。

## 测试

- `py -3.12 -X utf8 test/e2e_offline.py`：需要 `../compact-minimap/tools/vendor` 里的 lupa（Lua 5.1）。第 9 项测快捷菜单（菜单是模拟的：
  真实的 Blizzard_Menu 行为要对照 Gethe/wow-ui-source 的 `forever` 分支，并在游戏里点一遍）。第 10 项测采购清单
  （Auctionator 是模拟的：真实行为对照游戏目录里 Auctionator 的 `Source/API/v1/ShoppingLists.lua` 和 `Source/Tabs/Shopping`）。
  第 11 项测地图位置（C_Map、QuestieDB、Questie ZoneDB 是模拟的：worldmap 链接点了能不能放标记要在游戏里点一下确认）。
- `node test/web_plugin_offline.mjs`：插件 + 假宿主，测会话续接、重置、超时取消、卸载后不写、管道被占重试、零未捕获错误。
- `node test/setup_offline.mjs`：找游戏目录（假的 WoW 目录树）、游戏开着/关着时的安装行为、没有游戏目录时插件照常运行、升级检查（假的 GitHub）。
- `node test/wowf_policy_offline.mjs`：工具策略（白名单、网址检查、按服务器换价格工具、按会话隐藏、卸载后解除）和 `prompt()` 的服务器/价格说明（欧服、美服、国服）。
- `node test/market_offline.mjs`：wowauctions 页面数据（`test/fixtures/` 里存的 `__NEXT_DATA__`）解析、判断规则、缓存。
- 改完这两个都要全过，再重启 dsh web，在游戏里 `/reload` 后 `/dshc test`。

## 日志和状态

- `%APPDATA%\DSHBridge\web-bridge.log`：dsh web 插件；`bridge.log`：独立桥接；`tts-engine.log`：语音引擎。
- `%APPDATA%\DSHBridge\web-sessions.json`：角色 → DSH 会话。
