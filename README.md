# DSHChat · WoW Forever Addon

在《魔兽世界：无限》聊天框里加一个只在本地的 **[DSH] 频道**：在里面提问，由你电脑上的 DeepSeek Harness（DSH）回答，回答显示在聊天框里。
还能翻译（中文 ↔ 英文），查拍卖行行情和制作利润，在地图上标位置，把要买的材料放进 Auctionator 购物清单。

DSHChat is a World of Warcraft: Forever addon for Windows that connects in-game chat to DeepSeek Harness. It supports Auction House prices, crafting profit rankings, clickable item links, Auctionator shopping lists, map pins, and Chinese–English translation. The addon requires the DSH Web bridge and the DSH Bridge voice engine.

```
游戏里 /dsh 提问（可以 Shift 点物品）
  → 插件用静音语音“朗读”问题（C_VoiceChat.SpeakText，音量 0）
  → DSHBridge 假语音收到文字，经命名管道 \\.\pipe\DSHBridge 直接推进 dsh web
  → dsh web 里的插件把问题交给“魔兽世界无限服”模式的会话（每个角色一个会话，记得上下文，只有只读的魔兽资料工具）
  → 回答写成字体文件（字形宽度 = 字节），放进 Interface\AddOns\DSHChat\mail\ 的槽位
  → 插件加载字体、量出宽度读回回答，打印到聊天框（提到的物品变成可点链接）
```

不读游戏内存、不模拟按键、不在屏幕上画东西，也不会替你购买或发言。

## 安装

需要：Windows、《魔兽世界：无限》、[DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)（`dsh web`，配好 DeepSeek 账号）、Git。

1. **装 DSH 插件**：打开 `dsh web` → 侧栏 **插件** → 安装，填[最新 GitHub Release](https://github.com/robeson1010/dsh-wow-bridge/releases/latest)里的安装地址
   （形如 `git+https://github.com/…/dsh-wow-bridge.git#<提交号>&path:/dsh-web`，要带完整提交号，以后才能自动升级）。
2. **在设置页里设置**：DSH 的 **设置 › 魔兽世界**（和“通用 / 模型 / 插件”同一级；插件页里本插件的详情也有同一页）：
   - **服务器和阵营**：欧服、美服或国服，以及规则集（PvP / PvE / RP …）；阵营选“按角色自动”、部落或联盟。
   - **游戏目录**：一般会自动找到；找不到就点“选择文件夹…”或填路径（`World of Warcraft` 或里面的 `_forever_` 都行）。
   - **安装游戏插件**：把 DSHChat 装进 `_forever_\Interface\AddOns\`，并建好 1024 个回信槽位。最好关着游戏装；
     游戏开着时只能更新已有文件，新文件等你退出游戏后自动装。
   - **安装静音语音**：编译语音引擎并弹一次“用户账户控制”（只写入语音名片）。装完要完整重启游戏。
   - **升级**：dsh web 每 6 小时到 GitHub 检查一次，打开设置页时也会检查。
     - 点“升级到 x”：装好后自动重启 dsh web（重启后的 dsh web 在后台运行，不在原来的终端窗口里）。
     - “有新版本时自动下载安装”（默认开）：在后台装好，不打断你；设置页出现“重启 dsh web”，点了才生效。
     - 升级后插件会把游戏插件同步到新版本（游戏开着时 `/reload` 生效）。DSH 桌面版由桌面版自己重启。
3. 开游戏，在角色选择界面的插件列表里确认 **DSH 频道** 已启用，进游戏后输入 `/dshc test`。

## 平时怎么用

- 开着 `dsh web` 就行（不需要开浏览器页面）。
- 游戏里：
  - `/dsh` 进入 DSH 频道（像 `/s` 一样会保持），直接打字提问；可以 Shift 点物品。
  - `/dshc test` 测试链路；`/dshc reset`（或在频道里打“新对话”）开新对话；`/dshc status` 看状态。
  - 宏里用 `/dshq 问题`。
  - **翻译**：`/dsht` 进入 **[DSH 翻译]** 频道，也会保持。打中文翻成英文，打英文翻成中文。
    译文后面有 **[复制译文]**：点了弹出译文（已选中），Ctrl+C 复制，到聊天框 Ctrl+V，按回车发出去。
    复制译文用的是 DSH 自己的窗口，以免设置原生聊天框触发游戏的受限操作拦截。
    翻译用每个角色单独的一个对话，不会占用 DSH 频道的上下文；在翻译频道里打“新对话”也只是翻译这三个字。
  - **快捷提问**：点屏幕上的 **DSH** 按钮（按住可拖动）打开菜单，点一下就发出去：
    - **打字提问**：选 `/DSH`（DSH 提问）、`/S`（说话）、`/P`（小队）或 `/G`（公会），打开游戏聊天框并填入对应命令。输入正文后由玩家按回车提交。战斗中暂停自动切换，脱战后重新打开菜单即可使用。
    - `/dshc chatdiag` 显示最近一次自动切换的目标、实际检测到的频道、聊天限制和切换后 60 秒内捕获的受限操作。发生拦截后，本次界面会话内改为显示手动输入提示。
    - **开新对话**：等于 `/dshc reset`。
    - 固定问题：我现在该做什么？/ 附近有什么任务？/ 这里适合刷什么？
    - **行情**：鼠标指着的物品（30 秒内看过的也算）现在多少钱、适合买还是卖。
    - **制作利润**：选专业（你自己的专业排在最前面），问现在做什么拿去拍卖行卖最赚钱。
    - 你自己的问题。
  - **回复状态**：问题发出去还没收到回答时，DSH 按钮旁边显示“正在回复… N 秒”（开新对话、链路测试、
    长回答分段到达时也会显示）；回答到了或 150 秒超时后消失。按钮隐藏时不显示。
  - **采购清单（Auctionator）**：问“裁缝现在做什么最赚钱”“做 10 个厚符文布绷带要买什么”这类问题时，DSH 会在回答里附上
    要在拍卖行买的材料。聊天框列出清单，后面跟一个 **[加进 Auctionator]**。**不会自动加**，下面几种情况才放进 Auctionator
    购物清单 **「DSH 采购」**（每次替换这一份，不会越堆越多）：
    - 点聊天框里的 **[加进 Auctionator]**（最近 20 份清单的链接都能点）；
    - 打 `/dshc buy`（加最新一份），或者在 DSH 按钮菜单里点“采购清单加进 Auctionator”；
    - 提问时直接要求，比如“做 10 个厚符文布绷带，材料加进购物清单”，或者看完清单后在频道里说“加进购物清单”。
    加进去以后：
    - 人在拍卖行：直接打开 Auctionator 的购物页并搜索。不在拍卖行：下次打开拍卖行时自动打开（/reload、重新登录也记得）。
    - 提问时要求加的，回答到达时你正在拍卖行确认购买或打字，不会切页面打断你：聊天框提示“已备好”，点链接或打 `/dshc buy` 再打开。
    - **买不买、买多少还是你自己点**，插件不会自动购买。
    - 没说做几次就按 5 次算，可以直接说“做 20 次”。商人卖的材料不放进清单。没启用 Auctionator 时只列在聊天框。
  - **地图标记（游戏自带的地图标记）**：回答里提到 NPC、任务地点、采集点时，后面会跟一个黄色的
    **[📍 地图名 x, y]** 链接。**不会自动标**：
    - 点这个链接：游戏自己在地图上放标记（和 Ctrl+点地图放的是同一种），并打开地图。
    - 提问时要求，比如“霍格在哪，标到地图”“帮我导航到飞行点”“带我去奥格的银行”：回答到了直接标第一个位置。
      句子里有“不要 / 别 / 取消”这类词时不标；只问“在哪”“坐标多少”也不标。战斗中或地图开着时不替你标，点链接就行。
    - 坐标来自无限图鉴（任务给予者、交任务的人、任务目标）；DSH 给出 NPC 编号时，从你装的 QuestieDB 里找无限服的刷新点
      （优先你所在地图上最近的那个）。没装 Questie 时只显示名字。
    - 在地图上点这个标记可以开关追踪。
  - **快捷键**：按 Esc › 选项 › 按键设置 › “DSH 频道”，可以绑两个键：打开快捷菜单（在鼠标位置弹出）、
    问鼠标指着的物品的行情（指着背包里的物品直接按）。
  - 自己的问题：`/dshc add 问题`（可以 Shift 点物品，最多 30 条）、`/dshc list`、`/dshc del 编号`。
    按钮：`/dshc button off`（隐藏，快捷键照样能用）、`on`、`reset`（回到默认位置）。
- 在 dsh web 里：游戏里的对话叫“魔兽 · 角色名-服务器”，可以直接看。在设置页的“游戏对话放在哪里”选一个已有的工作区，它们就排在那下面（插件不会自己建工作区）。
  新建任务时模式列表里会多一个“魔兽世界无限服”（游戏专用，只读资料工具）：别把它设成默认。

## 资料和价格从哪来

- **游戏数据**（物品、掉落、任务、NPC、副本、配方、专业冲级、采集、天赋、地图、传承树）：无限图鉴的 MCP（https://wuxianwow.com/mcp，免费），数据来自国服客户端，名字是中文。
- **攻略、玩法**：网页搜索（关键词带 wowhead / WoW Forever）。Wowhead 的 /forever/ 页面拒绝自动读取，用搜索摘要。
- **价格和商机：只从网上查**，按设置页里的服务器和阵营，不用本机插件的数据（Auctionator 只用来接收采购清单）：
  - **欧服、美服**：wowauctions.net（大约每小时扫描一次），插件给 DSH 两个专用工具：
    - `wow_item_market`：一件物品的最低一口价、市场价、在售数量、30 天中位数和区间、涨跌、日销量、卖店价，
      **商人卖不卖**（无限图鉴的商人货单，玩家在无限服记下的，临时数据），并判断能不能**捡漏卖店**、是**偏低（低吸）**还是**偏高（高抛）**、有没有人**压价/扫货**。例：`/dsh [符文布] 现在适合买吗？`
    - `wow_craft_profit`：从销量最好的 40 个配方里筛掉有制作冷却的配方，列出盈利排名前 10（不足 10 个就列出全部符合条件的配方），带成本、卖价、利润、日销量、趋势和材料。材料标“商人有卖”的（同样查无限图鉴）不进采购清单，只有一两个商人卖的标“少数商人有”，照常算拍卖行材料。例：`/dsh 裁缝现在做什么最赚钱？`
    - 全市场的捡漏、扫货、压价、涨跌榜做不了（没有全市场挂单数据）。无限图鉴里的拍卖价是国服的，只会写成“国服参考价”。
  - **国服**：无限图鉴的拍卖行数据（`auction_house`，游戏内采集、每天更新），按规则集和阵营选拍卖行；这时上面两个工具不用。
  - 改了服务器或阵营，每个角色的下一个问题会开新对话（新对话的第一条消息写着服务器）。
- 读网页只允许 wowhead.com、wuxianwow.com、warcraft.wiki.gg、wowpedia.fandom.com、icy-veins.com、wowauctions.net（`dsh-web/wowf-tool-policy.js`）。

## 设置存在哪

设置页改的东西都写在 `%APPDATA%\DSHBridge\config.json`（这台电脑自己的设置，盖过 `cordis.patch.yml` 里的同名项）：

```json
{ "server": "eu-pvp", "faction": "auto", "wowDir": "E:/Games/World of Warcraft", "workspaceId": "…", "autoUpdate": true }
```

- `server`：`eu-pvp`、`eu-pve`、`eu-rp`、`eu-rp-pvp`、`us-pvp`、`us-pve`、`us-rp`、`us-rp-pvp`、`cn-pvp`、`cn-normal`、`cn-rp`。
- `faction`：`auto`（按角色）、`Horde`、`Alliance`。
- `wowDir`：游戏目录（不写就自动找）；也可以用 `addons` 直接给 AddOns 目录。
- `autoUpdate`：`false` 关掉自动升级。
- `workspaceId`：游戏对话放进哪个已有的 DSH 工作区（设置页里选；不写就不放进工作区）。

## 改回答方式

编辑 `dsh-web/cordis.patch.yml` 里 `preset-wowf` 的 `prefix`（人设），重启 dsh web，然后在游戏里 `/dshc reset`（已有会话保留旧人设，新会话才用新的）。
不要在人设里写两个连续的花括号：那是 DSH 的模板语法，写错会让这个模式的每次请求都报错。

## 开发

| 位置 | 内容 |
| --- | --- |
| `dsh-web/` | **DSH 插件**（组合包 `@local/dsh-wow-bridge`，自成一体）：`index.js` 桥接服务和设置页接口，`client.js` 设置页，`cordis.patch.yml` “魔兽世界无限服”模式 |
| `dsh-web/addon/DSHChat/` | 游戏插件：[DSH] 频道、翻译、语音发送、字体回信、物品链接、快捷菜单 |
| `dsh-web/voice/` | 静音语音引擎（C#，Windows 自带编译器编译）和安装脚本 |
| `dsh-web/lib/` | 共用代码：管道、游戏进程、字体回信、提问格式；`setup.mjs` 找游戏目录、装游戏插件；`settings.mjs` 服务器和阵营；`voice.mjs`；`update.mjs` |
| `bridge/bridge.mjs` | 不依赖 dsh web 的独立桥接（备用，和 DSH 插件不要同时开） |
| `test/` | 离线测试，见 `AGENTS.md` |

- 开发时可以把本地目录直接链接进 DSH：`node <npm>\@deepseek-ai\dsh\lib\bin.js plugin --profile web add <本目录>\dsh-web`
  （卸载：`... plugin --profile web remove @local/dsh-wow-bridge`）。链接装的版本不会自动升级。
- 改了 `dsh-web/` 里的代码后要重启 dsh web（热重载不看这些源文件）。改游戏插件就改 `dsh-web/addon/DSHChat/`：插件会把它同步进游戏目录。
- 发版：改 `dsh-web/package.json` 和 `DSHChat.toc` 的版本号，推到 `main`；已安装的插件 6 小时内发现并升级。

## 日志

- DSH 插件：`%APPDATA%\DSHBridge\web-bridge.log`（也打印在 dsh web 的终端里）
- 独立桥接：`%APPDATA%\DSHBridge\bridge.log`；语音引擎：`%APPDATA%\DSHBridge\tts-engine.log`
- 角色 → 会话的对应表：`%APPDATA%\DSHBridge\web-sessions.json`

## 限制

- 回信槽位每次游戏进程 1024 个，用完要完整重启游戏（/reload 不够）。
- dsh web 没开时问题收不到；超过 140 秒的旧问题会丢弃，游戏里 150 秒后提示没回答。
- 会话越聊越长，每个问题都会带上之前的历史（花更多 token）。所以每答满 12 个问题（或者对话太长）会自动开新对话，
  新对话会带上上一段的最后一问一答；想马上换话题也可以 `/dshc reset`。每个问题用了多少 token 记在 `web-bridge.log`。
