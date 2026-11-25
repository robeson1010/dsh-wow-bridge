-- Quick questions: a draggable "DSH" button that opens a menu of common questions, two key bindings (open the menu;
-- ask the market question about the item under the mouse) and the player's own questions (/dshc add|del|list).
-- The menu also opens a selected chat channel, starts a new conversation and (once an answer listed materials) adds that
-- shopping list to Auctionator; while a question waits for its answer the button shows
-- "正在回复… N 秒" beside it.
-- Blizzard_Menu (MenuUtil / Menu.GetManager) is in this client and calls the generator and the callbacks through
-- securecallfunction. The channel picker has a diagnostic for the native chat path.
local ADDON, ns = ...
local Core = ns.Core

local QuickMenu = {}
ns.QuickMenu = QuickMenu

BINDING_HEADER_DSHCHAT = "DSH 频道"
BINDING_NAME_DSHCHAT_MENU = "打开 DSH 快捷提问菜单"
BINDING_NAME_DSHCHAT_MARKET = "问行情：鼠标指着的物品"

local FIXED = { "我现在该做什么？", "附近有什么任务？", "这里适合刷什么？" }
local TYPING_CHANNELS = { { "/DSH", "DSH 提问" }, { "/S", "说话" }, { "/P", "小队" }, { "/G", "公会" } }
-- crafting professions with a wowauctions profit page: skill line id -> name the market tool understands
local CRAFT = { { 171, "炼金" }, { 164, "锻造" }, { 185, "烹饪" }, { 333, "附魔" }, { 202, "工程" }, { 129, "急救" },
	{ 165, "制皮" }, { 186, "采矿" }, { 197, "裁缝" } }
local CRAFT_NAME = {}
for _, c in ipairs(CRAFT) do CRAFT_NAME[c[1]] = c[2] end
local CHILD = { [2937] = 171, [2938] = 164, [2939] = 185, [2940] = 333, [2941] = 202, [2942] = 129, [2945] = 165,
	[2946] = 186, [2948] = 197 }   -- child skill lines (classic tiers) -> base profession
local MAX_CUSTOM = 30
local ITEM_FRESH = 30              -- seconds a hovered item stays "the item" for the menu
local LABEL_CHARS = 24
local CHAT_WATCH_SECS = 60

local db                           -- DSHChatDB.quick
local button, openMenu
local lastItem                     -- { link, t }: the last item a tooltip showed
local lastSent, lastSentAt
local hooked                       -- the tooltip post-call is registered once
local chatWatch, chatStarted, chatBlocked

local function Usable(v) return type(v) == "string" and not (issecretvalue and issecretvalue(v)) and v ~= "" end

local function Send(text)
	local now = GetTime()
	if text == lastSent and lastSentAt and now - lastSentAt < 1.5 then return end   -- a double click sends once
	lastSent, lastSentAt = text, now
	Core:Ask(text)
end
QuickMenu.Send = Send

local function MarketText(link) return "行情：" .. link .. " 现在多少钱，适合买还是卖？" end
local function CraftText(name) return ("制作利润：%s 现在做什么拿去拍卖行卖最赚钱？"):format(name) end
QuickMenu.MarketText, QuickMenu.CraftText = MarketText, CraftText

-- ---- the item under the mouse ----
-- link (or nil, item id) of the item a tooltip shows. filling: called from the tooltip post-call, which Blizzard runs
-- after storing the tooltip data but before Show() (TooltipDataHandler InternalProcessInfo), so IsShown is still false
local function TooltipItem(tt, filling)
	if not (tt and (filling or (tt.IsShown and tt:IsShown()))) then return nil end
	local okT, isItem = pcall(tt.IsTooltipType, tt, Enum.TooltipDataType.Item)
	if not (okT and isItem) then return nil end
	local ok, _, link, id = pcall(TooltipUtil.GetDisplayedItem, tt)
	if ok and Usable(link) then return link end
	if not (ok and type(id) == "number") then
		local okD, data = pcall(tt.GetPrimaryTooltipData, tt)
		id = okD and type(data) == "table" and type(data.id) == "number" and data.id or nil
	end
	if id then
		local okI, _, l = pcall(C_Item.GetItemInfo, id)
		if okI and Usable(l) then return l end
		return nil, id
	end
	return nil
end

local function HoveredItem()
	local link, id = TooltipItem(GameTooltip)
	if link then return link end
	local link2, id2 = TooltipItem(ItemRefTooltip)   -- the window a clicked chat link opens
	if link2 then return link2 end
	return nil, id or id2
end
QuickMenu.HoveredItem = HoveredItem

-- ---- professions ----
-- the character's own crafting professions { {id, label}, ... } and a set of their ids
local function Professions()
	local mine, seen = {}, {}
	if type(GetProfessions) ~= "function" or type(GetProfessionInfo) ~= "function" then return mine, seen end
	local ok, r = pcall(function() return { n = select("#", GetProfessions()), GetProfessions() } end)
	if not ok or type(r) ~= "table" then return mine, seen end
	for i = 1, r.n do
		local index = r[i]
		if index then
			local okI, name, _, rank, maxRank, _, _, skillLine = pcall(GetProfessionInfo, index)
			if okI and type(skillLine) == "number" then
				local id = CHILD[skillLine] or skillLine
				if not CRAFT_NAME[id] and C_SkillInfo and C_SkillInfo.GetSkillLineInfoByID then
					local okS, info = pcall(C_SkillInfo.GetSkillLineInfoByID, skillLine)
					local parent = okS and type(info) == "table" and info.parentSkillLineID
					if type(parent) == "number" and parent ~= 0 then id = CHILD[parent] or parent end
				end
				if CRAFT_NAME[id] and not seen[id] then
					seen[id] = true
					local label = Usable(name) and name or CRAFT_NAME[id]
					if type(rank) == "number" and type(maxRank) == "number" then label = ("%s  %d/%d"):format(label, rank, maxRank) end
					mine[#mine + 1] = { id = id, label = label }
				end
			end
		end
	end
	return mine, seen
end
QuickMenu.Professions = Professions

-- ---- labels ----
local function Plain(q)   -- links -> their [name], codes stripped, a typed "|" kept visible
	local s = tostring(q or ""):gsub("||", "\1"):gsub("|H.-|h(.-)|h", "%1")
	return (Core.StripCodes(s):gsub("\1", "||"))
end

local function Truncate(s, maxChars)
	local count, i, len = 0, 1, #s
	while i <= len do
		count = count + 1
		if count > maxChars then return s:sub(1, i - 1) .. "…" end
		local c = s:byte(i)
		i = i + (c >= 0xF0 and 4 or c >= 0xE0 and 3 or c >= 0xC0 and 2 or 1)
	end
	return s
end
QuickMenu.Label = function(q) return Truncate(Plain(q), LABEL_CHARS) end

local function ManualChannel(command)
	Core.Say(("请在聊天框手动输入 %s 加空格。"):format(command))
end

local function WatchChatBlock(_, event, addon, action)
	local trial = db.lastChatSwitch
	if not (chatStarted and trial) or trial.event then return end
	local delay = GetTime() - chatStarted
	if delay > CHAT_WATCH_SECS then return end
	addon = Usable(addon) and addon or "未知"
	action = Usable(action) and action or "未知"
	if addon ~= ADDON and not action:find("SendChatMessage", 1, true)
		and not action:find("SetPreferredGamepadInteractTarget", 1, true) then return end
	trial.event, trial.addon, trial.action, trial.delay = event, addon, action, delay
	chatBlocked = true
	C_Timer.After(0, function()
		Core.Say("切频道后捕获到受限操作，已暂停自动切换。用 /dshc chatdiag 查看记录。")
	end)
end

local function OpenChannel(command)
	if InCombatLockdown and InCombatLockdown() then return Core.Say("战斗中暂停自动切频道。") end
	local util = ChatFrameUtil
	if chatBlocked or not (util and util.OpenChat and util.GetActiveWindow) then return ManualChannel(command) end
	local active = util.GetActiveWindow()
	if active then
		local draft = active:GetText()
		if (issecretvalue and issecretvalue(draft)) or (draft and draft ~= "") then return ManualChannel(command) end
	end
	if not chatWatch then
		chatWatch = CreateFrame("Frame")
		chatWatch:RegisterEvent("ADDON_ACTION_BLOCKED")
		chatWatch:RegisterEvent("ADDON_ACTION_FORBIDDEN")
		chatWatch:SetScript("OnEvent", WatchChatBlock)
	end
	local trial = { command = command, lockdown = C_ChatInfo and C_ChatInfo.InChatMessagingLockdown
		and C_ChatInfo.InChatMessagingLockdown() or false }
	db.lastChatSwitch, chatStarted = trial, GetTime()
	local ok, box = pcall(util.OpenChat, command .. " ")
	if not ok then
		trial.error = Usable(box) and box:sub(1, 240) or "未知错误"
		chatBlocked = true
		return ManualChannel(command)
	end
	-- OpenChat defers applying the text to the next OnUpdate on the normal edit box.
	C_Timer.After(0.2, function()
		if db.lastChatSwitch ~= trial or chatBlocked then return end
		local chatType = box and box == util.GetActiveWindow() and box:GetChatType()
		if Usable(chatType) then trial.chatType = chatType end
	end)
end

-- ---- the menu ----
local function Generate(_, root)
	root:CreateTitle("DSH 快捷提问")
	local ask = root:CreateButton("打字提问")
	local inCombat = InCombatLockdown and InCombatLockdown()
	for _, channel in ipairs(TYPING_CHANNELS) do
		local command, label = channel[1], channel[2]
		local item = ask:CreateButton(command .. " · " .. label, function() OpenChannel(command) end)
		if inCombat then
			item:SetEnabled(false)
			item:SetTooltip(function(tt) GameTooltip_SetTitle(tt, "战斗中暂停自动切频道") end)
		end
	end
	root:CreateButton("开新对话（/dshc reset）", function() SlashCmdList.DSHC("reset") end)
	-- the latest shopping list from an answer: added to Auctionator only when picked here (or confirmed in chat)
	local list = Core.LastBuy and Core.LastBuy()
	if list then
		local title = list.title ~= "" and ("：" .. Truncate(Plain(list.title), LABEL_CHARS)) or ""
		root:CreateButton("采购清单加进 Auctionator" .. title, function() Core.AddBuy(list, false) end)
	end
	root:CreateDivider()
	for _, q in ipairs(FIXED) do
		root:CreateButton(q, function() Send(q) end)
	end

	-- read the item now (when the menu opens): in the click callback the cursor is on the menu.
	-- the item under the mouse, else the last item any tooltip showed (30 s), else an open chat-link window: an old
	-- ItemRefTooltip must not win over an item hovered just before clicking the DSH button
	local link = TooltipItem(GameTooltip)
	if not link and lastItem and GetTime() - lastItem.t <= ITEM_FRESH then link = lastItem.link end
	if not link then link = TooltipItem(ItemRefTooltip) end
	if link then
		root:CreateButton("行情：" .. Plain(link), function() Send(MarketText(link)) end)
	else
		local d = root:CreateButton("行情：鼠标指着的物品")
		d:SetEnabled(false)
		d:SetTooltip(function(tt) GameTooltip_SetTitle(tt, "先把鼠标放在物品上（30 秒内），或者绑定快捷键：按键设置 › DSH 频道") end)
	end

	local craft = root:CreateButton("制作利润")
	local mine, seen = Professions()
	for _, p in ipairs(mine) do
		local name = CRAFT_NAME[p.id]
		craft:CreateButton(p.label, function() Send(CraftText(name)) end)
	end
	if #mine > 0 then craft:CreateDivider() end
	for _, c in ipairs(CRAFT) do
		if not seen[c[1]] then
			local name = c[2]
			craft:CreateButton(name, function() Send(CraftText(name)) end)
		end
	end

	root:CreateDivider()
	local questions = db and db.questions or {}
	if #questions == 0 then
		local d = root:CreateButton("自定义问题…（用 /dshc add 问题 添加）")
		d:SetEnabled(false)
	else
		for _, q in ipairs(questions) do
			local d = root:CreateButton(QuickMenu.Label(q), function() Send(q) end)
			d:SetTooltip(function(tt) GameTooltip_SetTitle(tt, q) end)
		end
		if #questions > 15 then root:SetScrollMode(400) end
	end
end
QuickMenu.Generate = Generate

local openFromButton                -- which entry point opened openMenu

local function Track(m, fromButton)
	if not m then return end
	openMenu, openFromButton = m, fromButton
	m:SetClosedCallback(function() if openMenu == m then openMenu = nil end end)
end

-- fromButton: anchored under the DSH button; otherwise at the cursor (the key binding).
-- The same entry point again closes the menu; the other one moves it (button click while the key menu is open).
function QuickMenu.Toggle(fromButton)
	fromButton = fromButton and button and button:IsVisible() and true or false
	if openMenu then
		local same = openFromButton == fromButton
		local m = openMenu
		openMenu = nil
		m:Close()
		if same then return end
	end
	if fromButton then
		local root = MenuUtil.CreateRootMenuDescription(MenuVariants.GetDefaultContextMenuMixin())
		Menu.PopulateDescription(Generate, button, root)
		local m = Menu.GetManager():OpenMenu(button, root, CreateAnchor("TOPLEFT", button, "BOTTOMLEFT", 0, -2))
		if m then PlaySound(SOUNDKIT.IG_MAINMENU_OPTION_CHECKBOX_ON) end
		Track(m, true)
	else
		Track(MenuUtil.CreateContextMenu(UIParent, Generate), false)
	end
end

-- ---- key bindings (Bindings.xml runs these in the global environment) ----
function DSHChat_ToggleQuickMenu()
	local ok, err = pcall(QuickMenu.Toggle, false)
	if not ok then Core.Say("快捷菜单出错：" .. tostring(err)) end
end

function DSHChat_AskHoveredMarket()
	local link, id = HoveredItem()
	if link then return Send(MarketText(link)) end
	if id and Item and Item.CreateFromItemID then
		local ok, item = pcall(Item.CreateFromItemID, Item, id)
		-- ContinueOnItemLoad errors for an id the client does not know (IsItemEmpty) and calls back even if loading failed
		if ok and item and pcall(item.ContinueOnItemLoad, item, function()
			local okL, l = pcall(item.GetItemLink, item)
			if okL and Usable(l) then Send(MarketText(l)) else Core.Say("读不到这件物品的信息，换个物品再试。") end
		end) then
			return
		end
	end
	Core.Say("鼠标没有指着物品：把鼠标放在物品上再按键（默认聊天框要先点开链接）。")
end

-- ---- the button ----
local DEFAULT_POINT = { point = "BOTTOMLEFT", relativePoint = "BOTTOMLEFT", x = 380, y = 220 }

local POINTS = { TOPLEFT = true, TOP = true, TOPRIGHT = true, LEFT = true, CENTER = true, RIGHT = true,
	BOTTOMLEFT = true, BOTTOM = true, BOTTOMRIGHT = true }

local function ValidPoint(p)
	return type(p) == "table" and POINTS[p.point] and POINTS[p.relativePoint]
		and type(p.x) == "number" and type(p.y) == "number"
end

-- ---- "正在回复…" next to the button while a question waits for its answer ----
local KIND_TEXT = { ask = "正在回复", ping = "正在测试链路", reset = "正在开新对话" }

local function StatusText()
	local n, secs, kind, receiving = Core.Waiting()
	if n == 0 then return nil end
	local what = receiving and "正在接收回答" or KIND_TEXT[kind] or "正在回复"
	local more = n > 1 and ("（%d 个问题）"):format(n) or ""
	return ("%s… %d 秒%s"):format(what, math.floor(secs), more)
end
QuickMenu.StatusText = StatusText

-- the label goes on the side of the button that faces the middle of the screen (stays on screen)
local function PlaceStatus()
	local label = button and button.status and button.status.label
	if not label then return end
	local x = button:GetCenter()
	local w = UIParent:GetWidth()
	label:ClearAllPoints()
	if type(x) == "number" and type(w) == "number" and x > w / 2 then
		label:SetPoint("RIGHT", button, "LEFT", -4, 0)
	else
		label:SetPoint("LEFT", button, "RIGHT", 4, 0)
	end
end

local function MakeStatus(b)
	local f = CreateFrame("Frame", nil, b)   -- a child: hidden with the button
	f:SetAllPoints(b)
	local label = f:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
	label:SetTextColor(0.40, 0.80, 1.00)
	label:Hide()
	f.label = label
	local nextUpdate = 0
	f:SetScript("OnUpdate", function()
		local now = GetTime()
		if now < nextUpdate then return end
		nextUpdate = now + 0.25
		local ok, text = pcall(StatusText)
		if ok and text then
			label:SetText(text)
			label:Show()
		else
			label:Hide()
		end
	end)
	return f
end

local function Place()
	if db.button ~= nil and not ValidPoint(db.button) then db.button = nil end   -- a damaged SavedVariables entry
	local p = db.button or DEFAULT_POINT
	button:ClearAllPoints()
	button:SetPoint(p.point or "BOTTOMLEFT", UIParent, p.relativePoint or "BOTTOMLEFT", p.x or 0, p.y or 0)
	button:SetShown(db.shown ~= false)
	PlaceStatus()
end

local function MakeButton()
	local b = CreateFrame("Button", nil, UIParent, "UIPanelButtonTemplate")
	b:SetSize(44, 22)
	b:SetText("DSH")
	b.tooltipText = "DSH 快捷提问：左键打开菜单，按住拖动"
	b:SetFrameStrata("MEDIUM")
	b:SetMovable(true)
	b:SetClampedToScreen(true)
	b:SetDontSavePosition(true)
	b:RegisterForDrag("LeftButton")
	b:RegisterForClicks("LeftButtonUp")
	-- a second click closes the menu instead of closing it on mouse-down and reopening it on mouse-up
	function b:HandlesGlobalMouseEvent(btn, event) return event == "GLOBAL_MOUSE_DOWN" and btn == "LeftButton" end
	b:SetScript("OnDragStart", function(self)
		if openMenu then openMenu:Close() end
		self.moving = true
		self:StartMoving()
	end)
	b:SetScript("OnDragStop", function(self)
		self:StopMovingOrSizing()
		self:SetUserPlaced(false)
		local p, _, rp, x, y = self:GetPoint(1)
		db.button = { point = p, relativePoint = rp, x = x, y = y }
		PlaceStatus()
		C_Timer.After(0, function() self.moving = nil end)
	end)
	b:SetScript("OnClick", function(self)
		if self.moving then return end
		local ok, err = pcall(QuickMenu.Toggle, true)
		if not ok then Core.Say("快捷菜单出错：" .. tostring(err)) end
	end)
	b.status = MakeStatus(b)
	return b
end

function QuickMenu.Init()
	DSHChatDB.quick = DSHChatDB.quick or {}
	db = DSHChatDB.quick
	if type(db.questions) ~= "table" then db.questions = {} end
	if db.shown == nil then db.shown = true end
	-- remember the last item a tooltip showed: the menu opened from the button only sees the button's own tooltip
	if not hooked and TooltipDataProcessor and TooltipDataProcessor.AddTooltipPostCall and Enum and Enum.TooltipDataType then
		hooked = true
		TooltipDataProcessor.AddTooltipPostCall(Enum.TooltipDataType.Item, function(tt)
			pcall(function()
				if tt == GameTooltip or tt == ItemRefTooltip then
					local link = TooltipItem(tt, true)
					if link then lastItem = { link = link, t = GetTime() } end
				end
			end)
		end)
	end
	button = button or MakeButton()
	Place()
end

-- ---- /dshc chatdiag | add | del | list | button ----
Core.commands.chatdiag = function()
	local trial = db and db.lastChatSwitch
	if not trial then return Core.Say("还没有自动切频道的记录。") end
	Core.Say(("最近切换 %s · 检测到的频道 %s · 聊天 API 限制 %s"):format(trial.command,
		Plain(trial.chatType or "未确认"), trial.lockdown and "已开启" or "未开启"))
	if trial.error then Core.Say("打开聊天框出错：" .. Plain(trial.error)) end
	if trial.event then
		Core.Say(("切换后 %.2f 秒捕获 %s · 插件 %s · 函数 %s"):format(trial.delay,
			trial.event, Plain(trial.addon), Plain(trial.action)))
	elseif not trial.error then
		Core.Say("未捕获相关的受限操作事件。")
	end
end

Core.commands.add = function(rest)
	local q = strtrim(rest or "")
	if q == "" then return Core.Say("用法：/dshc add 问题（可以 Shift 点物品链接）") end
	if not db then return end
	if #db.questions >= MAX_CUSTOM then return Core.Say(("最多 %d 条，先 /dshc del 删掉几条。"):format(MAX_CUSTOM)) end
	db.questions[#db.questions + 1] = q
	Core.Say(("已添加第 %d 条：%s"):format(#db.questions, q))
end

Core.commands.del = function(rest)
	local n = tonumber(strtrim(rest or ""))
	if not (db and n and db.questions[n]) then return Core.Say("用法：/dshc del 编号（/dshc list 看编号）") end
	local q = table.remove(db.questions, n)
	Core.Say(("已删除第 %d 条：%s"):format(n, q))
end

Core.commands.list = function()
	if not db or #db.questions == 0 then return Core.Say("还没有自定义快捷提问：/dshc add 问题") end
	for i, q in ipairs(db.questions) do Core.Say(("%d. %s"):format(i, q)) end
end

Core.commands.button = function(rest)
	if not (db and button) then return end
	local arg = strtrim(rest or ""):lower()
	if arg == "on" then
		db.shown = true
		button:Show()
	elseif arg == "off" then
		db.shown = false
		button:Hide()
		Core.Say("按钮已隐藏；按键设置 › DSH 频道 里的快捷键仍可用（/dshc button on 恢复）。")
	elseif arg == "reset" then
		db.button, db.shown = nil, true
		Place()
	else
		Core.Say("用法：/dshc button on|off|reset")
	end
end
