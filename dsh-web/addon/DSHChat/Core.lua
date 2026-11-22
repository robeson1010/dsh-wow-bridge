-- DSH Chat: a local-only [DSH] channel in the chat window. Text typed in it never reaches the server: it is caught in
-- Blizzard's pre-send event, sent to the bridge on this PC through the silent voice (Voice.lua), and the answer comes
-- back through the font mailbox (Mailbox.lua) and is printed in the chat window.
local _, ns = ...
local Voice, Mailbox, Font = ns.Voice, ns.Mailbox, ns.Font

local Core = {}
ns.Core = Core
Core.commands = {}   -- /dshc word -> function(rest): subcommands from this file (buy) and QuickMenu.lua; rest keeps case and links

local KEY = "DSH"
local R, G, B = 0.40, 0.80, 1.00
local TAG = "|cff66ccff[DSH]|r "
local TIMEOUT = 150        -- seconds before a question counts as unanswered (a late answer is still shown)

local pending = {}         -- id -> { t, q, parts = {}, got }
local late = {}            -- id -> { asked, q }: timed out, an answer may still come
local counter = 0

-- The chat type: "/dsh" switches the edit box to it and it stays (sticky), like /s or /p.
ChatTypeInfo[KEY] = { sticky = 1, flashTab = false, flashTabOnGeneral = false, r = R, g = G, b = B }
_G["SLASH_" .. KEY .. "1"] = "/dsh"
_G["CHAT_" .. KEY .. "_SEND"] = "[DSH]: "

-- The translation chat type: "/dsht" (or the quick menu's 帮我翻译). Chinese is translated to English, English (or
-- anything else) to Chinese. Also sticky, so the player can keep translating.
local KEY_T = "DSHT"
ChatTypeInfo[KEY_T] = { sticky = 1, flashTab = false, flashTabOnGeneral = false, r = R, g = G, b = B }
_G["SLASH_" .. KEY_T .. "1"] = "/dsht"
_G["CHAT_" .. KEY_T .. "_SEND"] = "[DSH 翻译]: "
local lastOut           -- the chat type the player last really sent in (with its whisper/channel target)
local trTexts, trSerial = {}, 0   -- serial -> translation, for the [填入聊天框] links (the last 20 work)

local function Frame() return DEFAULT_CHAT_FRAME end

local function Say(msg)
	Frame():AddMessage(TAG .. msg, R, G, B)
end
Core.Say = Say

-- AI text is untrusted: "|" starts UI escape codes, so it is doubled
local function Plain(s) return (tostring(s or ""):gsub("|", "||")) end

-- UI escape codes out of a string: colours (|cffRRGGBB, |cnNAME:), |r, textures, atlases, protected strings
local function StripCodes(s)
	s = tostring(s or "")
	s = s:gsub("|c%x%x%x%x%x%x%x%x", ""):gsub("|cn[^:|]*:", ""):gsub("|r", "")
	s = s:gsub("|T.-|t", ""):gsub("|A.-|a", ""):gsub("|K.-|k", "?")
	return s
end
Core.StripCodes = StripCodes

-- An item link for {{item:ID|Name}} in an answer. An item the player linked in the question comes back as the
-- player's own link (keeps random-suffix stats). Otherwise the client's link, only when the client knows that item
-- under that name (an AI can get an id wrong); otherwise the name as plain text.
local function ItemToken(id, name, asked)
	if asked and asked[id] then return asked[id] end
	local ok, itemName, link = pcall(C_Item.GetItemInfo, id)
	if ok and type(itemName) == "string" and type(link) == "string" then
		-- a Chinese name (from 无限图鉴) cannot be compared on an English client: trust the id then
		if name == "" or itemName:lower() == name:lower() or name:find("[\128-\255]") then return link end
	elseif ok then
		pcall(C_Item.RequestLoadItemDataByID, id)   -- not cached yet: the next answer that names it gets a link
	end
	return "[" .. Plain(name ~= "" and name or ("item:" .. id)) .. "]"
end

-- ---------- map locations: {{loc:uiMapID,x,y|Name}} and {{npc:ID|Name}} -> the game's own map pin, on a click ----------
-- A location becomes a native "worldmap" link. Clicking it runs Blizzard's own handler, which sets the built-in map pin
-- (the C_Map user waypoint) and opens the map there, so nothing of ours runs. Nothing is marked on its own (the user's
-- rule). Only when the question asked for it ("标到地图", "导航"…) is the first location pinned straight away, and
-- never in combat or with the map open (an addon setting the pin then runs Blizzard's map code tainted).
-- NPC positions come from the player's QuestieDB (Forever spawn data; NpcDB is its public API) and Questie's zone
-- table; without them an {{npc:...}} is just its name.
local MAX_LOCS = 8
local PIN_ICON = "|A:Waypoint-MapPin-ChatIcon:13:13:0:0|a"

local function MapName(mapID)
	local ok, info = pcall(C_Map.GetMapInfo, mapID)
	return ok and type(info) == "table" and type(info.name) == "string" and info.name or nil
end

-- x, y on 0-100 (an answer may give the 0-1 fractions instead: both <= 1 counts as fractions). nil when the map is
-- unknown to this client or takes no pin.
local function NewLoc(mapID, x, y, label)
	mapID, x, y = tonumber(mapID), tonumber(x), tonumber(y)
	if not (mapID and x and y) then return end
	if x <= 1 and y <= 1 then x, y = x * 100, y * 100 end
	if x < 0 or x > 100 or y < 0 or y > 100 then return end
	local name = MapName(mapID)
	if not name then return end
	local okc, can = pcall(C_Map.CanSetUserWaypointOnMap, mapID)
	if okc and can == false then return end
	return { map = mapID, x = x, y = y, mapName = name, label = label or "" }
end

-- Blizzard's own waypoint link: |Hworldmap:uiMapID:x*10000:y*10000|h (what C_Map.GetUserWaypointHyperlink makes)
local function MapLink(loc)
	return ("|cffffff00|Hworldmap:%d:%d:%d|h[%s %s %.1f, %.1f]|h|r"):format(loc.map, math.floor(loc.x * 100 + 0.5),
		math.floor(loc.y * 100 + 0.5), PIN_ICON, Plain(loc.mapName), loc.x, loc.y)
end

local function ZoneMap(areaId)
	local loader = _G.QuestieLoader
	if type(loader) ~= "table" or type(loader.ImportModule) ~= "function" then return end
	local okm, zdb = pcall(loader.ImportModule, loader, "ZoneDB")
	-- ImportModule never fails (an unknown name gives an empty module): test for the function itself
	if not okm or type(zdb) ~= "table" or type(zdb.GetUiMapIdByAreaId) ~= "function" then return end
	local ok, id = pcall(zdb.GetUiMapIdByAreaId, zdb, areaId)
	return ok and tonumber(id) or nil
end

local function PlayerPos()
	local ok, map, x, y = pcall(function()
		local m = C_Map.GetBestMapForUnit("player")
		local p = m and C_Map.GetPlayerMapPosition(m, "player")
		if p then
			local px, py = p:GetXY()
			if issecretvalue and (issecretvalue(px) or issecretvalue(py)) then return end
			return m, px * 100, py * 100
		end
	end)
	if ok and map then return map, x, y end
end

-- The spawn to show: on the player's map the nearest one, else the first point of the zone with the most spawns.
-- QuestieDB spawns: { [AreaTable id] = { { x, y[, phase] }, ... } } on 0-100; instance spawns are { -1, -1 }.
local function NpcLoc(id, label)
	local db = _G.NpcDB
	if type(db) ~= "table" or type(db.spawns) ~= "function" then return end
	local okn, cname = pcall(db.name, id)
	cname = okn and type(cname) == "string" and cname or nil
	local ok, spawns = pcall(db.spawns, id)
	if not ok or type(spawns) ~= "table" then return nil, cname end
	local pmap, px, py = PlayerPos()
	local best, bestD, bestN
	for areaId, points in pairs(spawns) do
		local mapID = type(areaId) == "number" and areaId > 0 and type(points) == "table" and ZoneMap(areaId)
		if mapID then
			for _, pt in ipairs(points) do
				local x = type(pt) == "table" and tonumber(pt[1])
				local y = type(pt) == "table" and tonumber(pt[2])
				if x and y and x >= 0 and y >= 0 then
					if mapID == pmap then
						local d = (x - px) ^ 2 + (y - py) ^ 2
						if not bestD or d < bestD then best, bestD = { mapID, x, y }, d end
					elseif not bestD and (not bestN or #points > bestN) then
						best, bestN = { mapID, x, y }, #points
					end
				end
			end
		end
	end
	return best and NewLoc(best[1], best[2], best[3], label ~= "" and label or cname), cname
end

-- one {{kind:body}} token -> chat text, or nil for a kind that is not ours (shown as typed). found collects the
-- locations of one answer (for "asked to mark"), at most MAX_LOCS links per answer.
local function RenderToken(kind, body, asked, found)
	-- the separator may also come as a full-width bar (U+FF5C) from a Chinese answer
	body = body:gsub("\239\189\156", "|")
	if kind == "item" then
		local id, name = body:match("^(%d+)|?(.*)$")
		if not id then return end
		name = strtrim(name)
		name = name:match("^%[(.*)%]$") or name:match("^【(.*)】$") or name
		return ItemToken(tonumber(id), name, asked)
	elseif kind == "loc" or kind == "npc" then
		local head, label = body:match("^([^|]*)|?(.*)$")
		label = strtrim(StripCodes(label or ""))
		local loc, cname
		if kind == "loc" then
			local nums = {}
			for d in head:gsub("\239\188\140", ","):gmatch("%-?%d+%.?%d*") do nums[#nums + 1] = d end
			if #nums >= 3 then loc = NewLoc(nums[1], nums[2], nums[3], label) end
		else
			local id = tonumber(head:match("%d+"))
			if id then loc, cname = NpcLoc(id, label) end
		end
		-- an id that is not that NPC (an object id from a quest's starts/ends, a wrong id): no pin, as for items. A
		-- Chinese label cannot be compared on an English client: the id is trusted then
		if kind == "npc" and loc and cname and label ~= "" and not label:find("[\128-\255]") and cname:lower() ~= label:lower() then
			loc = nil
		end
		if loc and found then
			if #found >= MAX_LOCS then loc = nil else found[#found + 1] = loc end
		end
		local text = Plain(label)
		if cname and cname ~= "" and cname:lower() ~= label:lower() then   -- the client's (English) name too
			text = text ~= "" and (text .. "（" .. Plain(cname) .. "）") or Plain(cname)
		end
		if not loc then return text end
		return (text ~= "" and (text .. " ") or "") .. MapLink(loc)
	end
end

-- asked: item id -> the player's link, for the question this answers (may be nil); found: see RenderToken (may be nil)
local function RenderLine(line, asked, found)
	local out, pos = {}, 1
	while true do
		local s, e, kind, body = line:find("{{(%a+):([^{}]*)}}", pos)
		if not s then break end
		out[#out + 1] = Plain(line:sub(pos, s - 1))
		out[#out + 1] = RenderToken(kind:lower(), body, asked, found) or Plain(line:sub(s, e))
		pos = e + 1
	end
	out[#out + 1] = Plain(line:sub(pos))
	return table.concat(out)
end
Core.RenderLine = RenderLine

-- The question asked for a map mark: a request phrase in the player's own words (link names like "[Map Pin
-- Location]" do not count), no negation anywhere (refusing is the safe side: the links stay clickable), and words
-- that merely contain 标 (目标 / 坐标 …: "任务目标在哪" holds "标在") taken out first. Matched as bytes; ASCII lowercased.
local NOT_MARK = { "目标", "坐标", "商标", "指标", "路标", "锦标", "标志", "标准" }
local MARK_WORDS = { "标到", "标在", "标出", "标上", "标一下", "帮我标", "给我标", "标记一下", "标记到", "导航到", "导航去",
	"导航过去", "帮我导航", "给我导航", "带我去", "set a waypoint", "set waypoint", "mark it", "pin it", "mark on the map" }
local NO_MARK = { "不要", "不用", "别", "不必", "无需", "取消", "删", "去掉", "清除", "don't", "do not", "no need", "remove",
	"clear", "delete" }
local function AskedToMark(q)
	q = (tostring(q or ""):lower():gsub("%b[]", " "))
	for _, w in ipairs(NOT_MARK) do q = (q:gsub(w, " ")) end
	for _, w in ipairs(NO_MARK) do if q:find(w, 1, true) then return false end end
	for _, w in ipairs(MARK_WORDS) do if q:find(w, 1, true) then return true end end
	return false
end
Core.AskedToMark = AskedToMark

-- the player asked: put the game's own map pin on the first location (not in combat, not with the map open)
local function MarkNow(found)
	local loc = found[1]
	local where = ("%s %.1f, %.1f"):format(Plain(loc.mapName), loc.x, loc.y)
	local more = #found > 1 and ("（回答里还有 %d 个位置，点它们的地图链接可以换）"):format(#found - 1) or ""
	if InCombatLockdown and InCombatLockdown() then
		Say("战斗中不替你放地图标记：点回答里的地图链接就能标（" .. where .. "）。")
		return
	end
	if WorldMapFrame and WorldMapFrame.IsShown and WorldMapFrame:IsShown() then
		Say("地图开着时不替你放标记：点回答里的地图链接就能标（" .. where .. "）。")
		return
	end
	-- USER_WAYPOINT_UPDATED is synchronous, so its listeners would run as this addon. With the map closed the only
	-- Blizzard listener is the map's pin-toggle button (it registers at OnLoad; its OnHide already set it inactive, so
	-- skipping the event changes nothing): it is muted around the call, so no Blizzard map state is written tainted.
	local btn = WorldMapFrame and WorldMapFrame.WorldMapTrackingPinButton
	local muted = false
	if type(btn) == "table" and type(btn.IsEventRegistered) == "function" then
		local okr, reg = pcall(btn.IsEventRegistered, btn, "USER_WAYPOINT_UPDATED")
		if okr and reg then muted = pcall(btn.UnregisterEvent, btn, "USER_WAYPOINT_UPDATED") end
	end
	local ok, set = pcall(function()
		return C_Map.SetUserWaypoint(UiMapPoint.CreateFromCoordinates(loc.map, loc.x / 100, loc.y / 100))
	end)
	if muted then pcall(btn.RegisterEvent, btn, "USER_WAYPOINT_UPDATED") end
	if ok and set then
		Say(("已放上地图标记：%s%s%s。打开地图就能看到，在地图上点标记可以开关追踪。"):format(
			loc.label ~= "" and (Plain(loc.label) .. "，") or "", where, more))
	else
		Say("这个位置放不了地图标记（" .. where .. "）：点回答里的地图链接试试。")
	end
end

local function PrintAnswer(text, isLate, asked, found)
	local first = true
	for line in (text .. "\n"):gmatch("(.-)\r?\n") do
		if line ~= "" then
			local head = first and (isLate and "|cff66ccff[DSH]|r |cff999999(迟到的回答)|r " or TAG) or "      "
			Frame():AddMessage(head .. RenderLine(line, asked, found), R, G, B)
			first = false
		end
	end
	if first then Say("|cff999999(空回答)|r") end
end

-- What a hyperlink in the question points at, for DSH: items get their stats and tooltip text.
local function LinkDetails(data, shown)
	local kind, id = data:match("^(%a+):(%-?%d+)")
	local d = { type = kind or data:match("^(%a+)") or "link", id = tonumber(id), name = (shown:gsub("^%[(.*)%]$", "%1")) }
	if d.type == "item" and d.id then
		-- by the whole item string, not the bare id: random-suffix items ("... of the Monkey") keep their suffix
		local ok, name, _, quality, itemLevel, minLevel, itemType, subType, stack, equipLoc, _, sellPrice, _, _, bindType =
			pcall(C_Item.GetItemInfo, data)
		if ok and name then
			if d.name == "" then d.name = name end    -- otherwise keep the name the player saw
			d.quality, d.itemLevel, d.requiredLevel = quality, itemLevel, minLevel
			d.itemType, d.itemSubType, d.stack, d.sellPrice, d.bindType = itemType, subType, stack, sellPrice, bindType
			if type(equipLoc) == "string" and equipLoc ~= "" then d.equipLoc = _G[equipLoc] or equipLoc end
		end
	end
	if C_TooltipInfo and C_TooltipInfo.GetHyperlink then
		local ok, tip = pcall(C_TooltipInfo.GetHyperlink, data)
		if ok and type(tip) == "table" and type(tip.lines) == "table" then
			local lines = {}
			for i, line in ipairs(tip.lines) do
				if i > 30 then break end
				local t = StripCodes(line.leftText)
				if type(line.rightText) == "string" and line.rightText ~= "" then t = t .. "    " .. StripCodes(line.rightText) end
				if t ~= "" then lines[#lines + 1] = t end
			end
			if #lines > 0 then d.tooltip = lines end
		end
	end
	return d
end

-- The question for DSH: links become their plain names ("[Name]"), with the details alongside (at most 5 links).
local function Unlink(text)
	local links = {}
	-- a typed "|" is "||" in the edit box: keep it out of the code stripping
	local plain = text:gsub("||", "\1"):gsub("|H(.-)|h(.-)|h", function(data, shown)
		shown = StripCodes(shown)
		if #links < 5 then
			local ok, d = pcall(LinkDetails, data, shown)
			if ok and d then links[#links + 1] = d end
		end
		return shown
	end)
	plain = StripCodes(plain):gsub("\1", "|")
	-- the player's own item links (colour included), for the answer to link back to
	local asked = {}
	for full in text:gmatch("|c[^|]*|Hitem:%d+[^|]*|h.-|h|r") do
		local id = tonumber(full:match("|Hitem:(%d+)"))
		if id and not asked[id] then asked[id] = full end
	end
	for full in text:gmatch("|Hitem:%d+[^|]*|h.-|h") do
		local id = tonumber(full:match("|Hitem:(%d+)"))
		if id and not asked[id] then asked[id] = full end
	end
	return plain, links, asked
end
Core.Unlink = Unlink

-- JSON for the request (strings, numbers, booleans, arrays, tables with string keys)
local function Json(v)
	local t = type(v)
	if issecretvalue and issecretvalue(v) then return "null" end
	if t == "string" then
		return '"' .. v:gsub('[%c"\\]', function(c)
			if c == '"' then return '\\"' elseif c == "\\" then return "\\\\" end
			return ("\\u%04x"):format(c:byte())
		end) .. '"'
	elseif t == "number" then
		return (v == v and v ~= math.huge and v ~= -math.huge) and tostring(v) or "null"
	elseif t == "boolean" then
		return tostring(v)
	elseif t == "table" then
		local out = {}
		if #v > 0 then
			for i = 1, #v do out[i] = Json(v[i]) end
			return "[" .. table.concat(out, ",") .. "]"
		end
		for k, x in pairs(v) do
			if type(k) == "string" then out[#out + 1] = Json(k) .. ":" .. Json(x) end
		end
		return "{" .. table.concat(out, ",") .. "}"
	end
	return "null"
end
Core.Json = Json

local function Context()
	local c = {}
	pcall(function()
		c.name = UnitName("player")
		c.realm = GetRealmName()
		c.level = UnitLevel("player")
		c.class = UnitClass("player")
		c.race = UnitRace("player")
		c.zone = GetRealZoneText()
		c.subzone = GetSubZoneText()
	end)
	pcall(function()
		local map = C_Map.GetBestMapForUnit("player")
		local pos = map and C_Map.GetPlayerMapPosition(map, "player")
		if pos then
			local x, y = pos:GetXY()
			if not (issecretvalue and (issecretvalue(x) or issecretvalue(y))) then
				c.x, c.y = math.floor(x * 1000 + 0.5) / 10, math.floor(y * 1000 + 0.5) / 10
			end
		end
	end)
	pcall(function()
		c.faction = UnitFactionGroup("player")   -- "Horde" / "Alliance": Forever AHs are per faction (price page)
	end)
	return c
end

local function NewId()
	counter = (counter + 1) % 1000
	return ("%d%03d"):format(time(), counter)
end

local function Send(kind, text, links, asked)
	if Mailbox.Full() then
		Say("回信槽位用完了：请完整退出游戏再进（/reload 不够）。")
		return
	end
	local id = NewId()
	local body = { v = 1, type = kind, id = id, slot = Mailbox.Next(), q = text, ctx = Context() }
	if links and #links > 0 then body.links = links end
	local req = Json(body)
	local ok, why = Voice:Send(req, id)
	if not ok then
		if why == "no-voice" then
			Say("找不到 DSHBridge 语音：先运行 install-voice.ps1，再完整重启游戏。/dshc voices 可查看游戏看到的语音。")
		else
			Say("发送失败（文字转语音调用出错）。")
		end
		return
	end
	pending[id] = { t = GetTime(), q = text, parts = {}, got = 0, asked = asked, kind = kind }
	Mailbox.SetActive(true)
	return id
end

-- what is still waiting for an answer, for the status next to the DSH button:
-- count, seconds since the oldest was sent, the oldest one's kind ("ask" | "ping" | "reset"), whether parts are arriving
function Core.Waiting()
	local n, oldest, kind, receiving = 0, nil, nil, false
	for _, e in pairs(pending) do
		n = n + 1
		if e.t and (not oldest or e.t < oldest) then oldest, kind = e.t, e.kind end
		if e.got and e.got > 0 then receiving = true end
	end
	return n, oldest and (GetTime() - oldest) or 0, kind, receiving
end

function Core:Ask(text)
	text = strtrim(text or "")
	if text == "" then return end
	-- the player's own text, links and all (the edit box already escapes a typed "|")
	Frame():AddMessage("|cff66ccff[DSH] 你：|r" .. text, R, G, B)
	local plain, links, asked = Unlink(text)
	Send("ask", plain, links, asked)
end

-- ---------- translation ----------
function Core:Translate(text)
	text = strtrim(text or "")
	if text == "" then return end
	Frame():AddMessage("|cff66ccff[DSH 翻译] 原文：|r" .. text, R, G, B)
	local plain, links, asked = Unlink(text)
	Send("translate", plain, links, asked)
end

-- the translation as chat text: {{item:ID|Name}} -> the item link (or [Name]), other tokens dropped, one line
local function ChatText(text, asked)
	text = text:gsub("{{item:(%d+)|?([^{}]*)}}", function(id, name) return ItemToken(tonumber(id), name, asked) end)
	text = text:gsub("{{[^{}]*}}", ""):gsub("%s*\r?\n%s*", " ")
	return strtrim(text)
end

local function PrintTranslation(text, isLate, asked)
	local head = isLate and "|cff66ccff[DSH 译文]|r |cff999999(迟到的)|r " or "|cff66ccff[DSH 译文]|r "
	local found = {}
	local first = true
	for line in (text .. "\n"):gmatch("(.-)\r?\n") do
		if line ~= "" then
			Frame():AddMessage((first and head or "      ") .. RenderLine(line, asked, found), R, G, B)
			first = false
		end
	end
	if first then return Say("|cff999999(空回答)|r") end
	trSerial = trSerial + 1
	trTexts[trSerial], trTexts[trSerial - 20] = ChatText(text, asked), nil
	Frame():AddMessage(("      |cff66ccff|Haddon:DSHChat:tr:%d|h[填入聊天框]|h|r |cff999999放进你原来的聊天频道，按回车才发出去|r"):format(trSerial), R, G, B)
end

-- [填入聊天框]: the translation into the chat box, in the channel the player last really used (not a DSH one).
-- Nothing is sent: the player presses Enter.
local function FillChat(text)
	local open = ChatFrameUtil and ChatFrameUtil.OpenChat or ChatFrame_OpenChat
	if not open then return end
	open("")
	local eb = ChatFrameUtil and ChatFrameUtil.GetActiveWindow and ChatFrameUtil.GetActiveWindow()
	if not eb then return end
	local t = eb:GetChatType()
	if t == KEY or t == KEY_T then
		local o = lastOut or { type = "SAY" }
		eb:SetChatType(o.type)
		if o.tell then eb:SetTellTarget(o.tell) end
		if o.channel then eb:SetChannelTarget(o.channel) end
		if eb.UpdateHeader then eb:UpdateHeader() end
	end
	eb:SetText(text)
end

-- a click on [填入聊天框] (dispatched from the one SetItemRef callback below)
local function OnTranslationLink(n)
	local text = trTexts[tonumber(n)]
	if text then FillChat(text) else Say("这条译文太旧了，找不到了：请再翻译一次。") end
end

-- ---------- shopping lists: {{buy:Title|ID×N,ID×N}} in an answer -> (on confirmation) an Auctionator shopping list ----------
-- The line is taken out of the printed answer and shown as a list with a [加进 Auctionator] link. It goes into
-- Auctionator only when the player clicks that, types /dshc buy, picks it in the quick menu, or asked for it in the
-- question (the user does not want anything added on its own). The list is built from item ids: the names come from
-- this client, so Auctionator's exact-name search matches the client's language. Buying stays the player's own click.
local BUY_LIST = "DSH 采购"      -- one list, replaced by every new one: automatic lists must not pile up
local BUY_MAX, BUY_QTY_MAX = 12, 1000
local CALLER = "DSHChat"
local lastBuy                    -- the latest list from an answer, for /dshc buy and the quick menu
local pendingAH                  -- search terms of a list made away from the auction house: opened when it opens

-- the answer without its {{buy:...}} tokens, and their bodies (a nested {{item:ID|Name}} stays inside its body)
local function ExtractBuys(text)
	local out, bodies, pos = {}, {}, 1
	while true do
		local s = text:find("{{buy:", pos, true)
		if not s then break end
		local depth, i, e = 1, s + 6, nil
		while true do
			local o, c = text:find("{{", i, true), text:find("}}", i, true)
			if not c then break end
			if o and o < c then
				depth, i = depth + 1, o + 2
			else
				depth, i = depth - 1, c + 2
				if depth == 0 then e = c + 1 break end
			end
		end
		if not e then break end      -- not closed: left as text
		out[#out + 1] = text:sub(pos, s - 1)
		bodies[#bodies + 1] = text:sub(s + 6, e - 2)
		pos = e + 1
	end
	out[#out + 1] = text:sub(pos)
	return table.concat(out), bodies
end
Core.ExtractBuys = ExtractBuys

-- "Title|14047×10, 2321x5" -> { title, items = { { id, qty }, ... } }. Lenient about what an AI writes: full-width
-- bar, ×/*/x, Chinese commas, a name or {{item:...}} next to the id. In each entry the first number is the id and the
-- last one (when there are two or more) the quantity.
local function ParseBuy(body)
	body = body:gsub("{{item:(%d+)[^{}]*}}", "%1"):gsub("\239\189\156", "|")
	local title, list = body:match("^([^|]*)|(.*)$")
	if not title then title, list = "", body end
	list = list:gsub("\239\188\140", ","):gsub("\227\128\129", ","):gsub("\239\188\155", ",")
	local items, byId = {}, {}
	for entry in (list .. ","):gmatch("([^,;\n]+)") do
		local nums = {}
		for d in entry:gmatch("%d+") do nums[#nums + 1] = tonumber(d) end
		local id, qty = nums[1], #nums >= 2 and nums[#nums] or 1
		if id and id > 0 and id < 10000000 then
			qty = math.max(1, math.min(BUY_QTY_MAX, qty))
			if byId[id] then
				byId[id].qty = math.min(BUY_QTY_MAX, byId[id].qty + qty)
			elseif #items < BUY_MAX then
				byId[id] = { id = id, qty = qty }
				items[#items + 1] = byId[id]
			end
		end
	end
	title = strtrim((StripCodes(title):gsub("[|\"%^;{}]", "")))
	if #title > 60 then title = title:sub(1, 60):gsub("[\192-\255][\128-\191]*$", "") .. "…" end
	return { title = title, items = items }
end
Core.ParseBuy = ParseBuy

local function AuctionatorAPI()
	local api = type(Auctionator) == "table" and type(Auctionator.API) == "table" and Auctionator.API.v1
	if type(api) == "table" and type(api.CreateShoppingList) == "function" and type(api.ConvertToSearchString) == "function" then
		return api
	end
end

local function AuctionHouseShown()
	return (AuctionHouseFrame and AuctionHouseFrame:IsShown()) or (AuctionFrame and AuctionFrame:IsShown()) or false
end

local function Shown(f) return type(f) == "table" and type(f.IsShown) == "function" and f:IsShown() and true or false end

-- The player is in the middle of something at the AH: a purchase being confirmed (Auctionator's buy frames hold its
-- confirmation dialogs; their OnHide cancels the purchase), Blizzard's own buy views, a popup, or typing. A list that
-- arrives then must not switch tabs or restart a search under them.
local function AuctionHouseBusy()
	if GetCurrentKeyBoardFocus and GetCurrentKeyBoardFocus() then return true end
	if Shown(_G.AuctionatorBuyCommodityFrame) or Shown(_G.AuctionatorBuyItemFrame) then return true end
	local ah = _G.AuctionHouseFrame
	if type(ah) == "table" and (Shown(ah.CommoditiesBuyFrame) or Shown(ah.ItemBuyFrame) or Shown(ah.BuyDialog)) then return true end
	if type(StaticPopup_IsAnyDialogShown) == "function" then
		local ok, any = pcall(StaticPopup_IsAnyDialogShown)
		if ok and any then return true end
	end
	for i = 1, 4 do if Shown(_G["StaticPopup" .. i]) then return true end end
	return false
end

local function SetPendingAH(terms)
	pendingAH = terms
	if DSHChatDB then DSHChatDB.buyPending = terms end   -- survives /reload and relog until the AH opens
end

-- Another addon's list (ProfLevelHelper's, say) may have been opened after ours: tell the player where ours is.
local function CheckOpened()
	local lc = _G.AuctionatorShoppingFrame and AuctionatorShoppingFrame.ListsContainer
	if type(lc) ~= "table" or type(lc.GetExpandedList) ~= "function" then return end
	local ok, name = pcall(function() local l = lc:GetExpandedList() return l and l:GetName() end)
	if ok and name ~= BUY_LIST and AuctionHouseShown() then
		Say("「" .. BUY_LIST .. "」已经建好，但 Auctionator 购物页打开的是别的清单：在购物页点「" .. BUY_LIST .. "」，或者 /dshc buy。")
	end
end

-- At the auction house Auctionator's Shopping tab is shown first, so the new list opens there and (with its default
-- "search lists automatically") is searched right away. Away from it, or while the player is busy there (auto only),
-- the list waits for the next AUCTION_HOUSE_SHOW or /dshc buy.
-- Returns ok, err, how: "open" (opened at the AH), "later" (opens with the AH), "busy" (kept, nothing touched).
local function CreateList(api, terms, auto)
	local atAH = AuctionHouseShown()
	if auto and atAH and AuctionHouseBusy() then
		SetPendingAH(terms)
		return true, nil, "busy"
	end
	local tab = atAH and _G.AuctionatorTabs_Shopping
	if tab and tab.Click then
		pcall(tab.Click, tab)
		-- an automatic open must not keep the keyboard (chat typing would land in Auctionator's search box)
		pcall(function() AuctionatorShoppingFrame.SearchOptions.SearchString:ClearFocus() end)
	end
	local ok, err = pcall(api.CreateShoppingList, CALLER, BUY_LIST, terms)
	if not ok then return false, err end
	SetPendingAH(not atAH and terms or nil)
	if atAH then C_Timer.After(0.3, function() pcall(CheckOpened) end) end
	return true, nil, atAH and "open" or "later"
end

local function ItemNameLink(id)
	local ok, name, link = pcall(C_Item.GetItemInfo, id)
	if ok and type(name) == "string" and name ~= "" then return name, type(link) == "string" and link or nil end
	pcall(C_Item.RequestLoadItemDataByID, id)
end

-- Item names may still be loading: retried for up to 3 s, then done(spec) runs with what is known.
local function Resolve(spec, done, tries)
	tries = tries or 0
	local missing = 0
	for _, it in ipairs(spec.items) do
		if not it.name then
			it.name, it.link = ItemNameLink(it.id)
			if not it.name then missing = missing + 1 end
		end
	end
	if missing > 0 and tries < 6 then
		C_Timer.After(0.5, function() Resolve(spec, done, tries + 1) end)
		return
	end
	done(spec)
end

-- for chat: title ("「…」" or ""), the items with links, the unknown ids, how many items are known
local function Describe(spec)
	local shown, unknown = {}, {}
	for _, it in ipairs(spec.items) do
		if it.name then
			shown[#shown + 1] = (it.link or ("[" .. Plain(it.name) .. "]")) .. "×" .. it.qty
		else
			unknown[#unknown + 1] = "item:" .. it.id
		end
	end
	local title = spec.title ~= "" and ("「" .. Plain(spec.title) .. "」") or ""
	local tail = #unknown > 0 and ("（%d 个物品 ID 游戏里查不到：%s）"):format(#unknown, table.concat(unknown, "、")) or ""
	return title, table.concat(shown, "、"), tail, #shown
end

-- the clickable confirmation (an "addon" link: Blizzard's handler passes it to EventRegistry "SetItemRef")
local function AddLink(spec)
	return ("|cff66ccff|Haddon:DSHChat:buy:%d|h[加进 Auctionator]|h|r"):format(spec.serial)
end

-- Adds the list to Auctionator: only when the player clicks the link, types /dshc buy, picks it in the quick menu, or
-- asked for it in the question. asked: the answer arrives on its own, so a busy player at the AH is not interrupted.
local function AddBuy(spec, asked)
	Resolve(spec, function()
		local title, list, tail, known = Describe(spec)
		if known == 0 then
			Say("采购清单" .. title .. "里的物品 ID 游戏里都查不到，没有加进 Auctionator。")
			return
		end
		local api = AuctionatorAPI()
		if not api then
			Say("采购清单" .. title .. "：" .. list .. tail .. " |cff999999（没启用 Auctionator，加不进去）|r")
			return
		end
		local terms = {}
		for _, it in ipairs(spec.items) do
			if it.name and not it.name:find("[\";%^]") then
				local ok, term = pcall(api.ConvertToSearchString, CALLER, { searchString = it.name, isExact = true, quantity = it.qty })
				if ok and type(term) == "string" then terms[#terms + 1] = term end
			end
		end
		if #terms == 0 then
			Say("采购清单" .. title .. "：Auctionator 认不出这些物品名，没加进去。")
			return
		end
		local ok, err, how = CreateList(api, terms, asked)
		if not ok then
			Say("Auctionator 没能建购物清单：" .. Plain(err))
		elseif how == "busy" then
			Say(("采购清单%s已备好：%s%s。你正在拍卖行操作，没有打断你：点 %s 或打 /dshc buy 打开，或者关掉拍卖行再打开。"):format(
				title, list, tail, AddLink(spec)))
		else
			Say(("已加进 Auctionator 购物清单「%s」%s：%s%s。%s"):format(BUY_LIST, title, list, tail,
				how == "open" and "已在购物页打开并搜索，买不买你自己点。" or "下次打开拍卖行会自动打开并搜索，买不买你自己点。"))
		end
	end)
end
Core.AddBuy = AddBuy

-- Shows the list with its [加进 Auctionator] link; nothing is added until the player confirms.
local function OfferBuy(spec)
	Resolve(spec, function()
		local title, list, tail, known = Describe(spec)
		if known == 0 then
			Say("采购清单" .. title .. "里的物品 ID 游戏里都查不到。")
			return
		end
		local action = AuctionatorAPI()
			and ("  %s |cff999999（点它才加；也可以 /dshc buy）|r"):format(AddLink(spec))
			or " |cff999999（没启用 Auctionator，只列出来）|r"
		Say("采购清单" .. title .. "：" .. list .. tail .. action)
	end)
end

local buyLists, buySerial = {}, 0     -- serial -> list, for the chat links (the last 20)

-- The player asked to have it added (in the question that this answer replies to): add straight away. Otherwise wait
-- for a confirmation. Lowercase ASCII only; the Chinese words are matched as bytes.
local ADD_TARGETS = { "auctionator", "购物清单", "采购清单", "购物车", "拍卖行清单" }
local ADD_VERBS = { "加", "放", "导入", "发到", "发进", "建", "存", "add" }
local function AskedToAdd(q)
	q = tostring(q or ""):lower()
	local target = false
	for _, w in ipairs(ADD_TARGETS) do if q:find(w, 1, true) then target = true break end end
	if not target then return false end
	for _, w in ipairs(ADD_VERBS) do if q:find(w, 1, true) then return true end end
	return false
end
Core.AskedToAdd = AskedToAdd

local function HandleBuy(body, q)
	local spec = ParseBuy(body)
	if #spec.items == 0 then
		Say("这条回答带了采购清单，但格式不对，看不出要买什么。")
		return
	end
	buySerial = buySerial + 1
	spec.serial = buySerial
	buyLists[buySerial], buyLists[buySerial - 20] = spec, nil
	lastBuy = spec
	if AskedToAdd(q) then AddBuy(spec, true) else OfferBuy(spec) end
end

function Core.LastBuy() return lastBuy end

-- a click on [加进 Auctionator] or [填入聊天框]
EventRegistry:RegisterCallback("SetItemRef", function(_, link)
	local tr = type(link) == "string" and link:match("^addon:DSHChat:tr:(%d+)")
	if tr then return OnTranslationLink(tr) end
	local n = type(link) == "string" and link:match("^addon:DSHChat:buy:(%d+)")
	if not n then return end
	local spec = buyLists[tonumber(n)]
	if spec then AddBuy(spec, false) else Say("这份采购清单太旧了，找不到了：请再问一次 DSH。") end
end, buyLists)

-- /dshc buy: add the latest list
Core.commands.buy = function()
	if lastBuy then
		AddBuy(lastBuy, false)
	else
		Say("还没有采购清单：问 DSH 做什么赚钱、或者让它列要买的材料，回答里就会带上。")
	end
end

local function OnPacket(pkt)
	local e = pending[pkt.id]
	local wasLate = late[pkt.id]
	if not e and not wasLate then
		if pkt.id == "notice" then Say(Plain(pkt.text)) end
		return  -- an answer to a question from an earlier session
	end
	-- a late answer: late[id] kept the question's links and text
	e = e or { parts = {}, got = 0, asked = type(wasLate) == "table" and wasLate.asked or nil,
		q = type(wasLate) == "table" and wasLate.q or nil, kind = type(wasLate) == "table" and wasLate.kind or nil }
	if wasLate then pending[pkt.id] = e end
	if not e.parts[pkt.part] then
		e.parts[pkt.part] = pkt.text
		e.got = e.got + 1
	end
	if e.got >= pkt.parts then
		local all = {}
		for i = 1, pkt.parts do all[i] = e.parts[i] or "" end
		if e.kind == "translate" then      -- no lists, no map pins: just the translation and its [填入聊天框]
			pending[pkt.id], late[pkt.id] = nil, nil
			local ok, err = pcall(PrintTranslation, table.concat(all), wasLate, e.asked)
			if not ok then Say("译文显示出错：" .. Plain(err)) end
			if not next(pending) then Mailbox.SetActive(false) end
			return
		end
		local text, buys = ExtractBuys(table.concat(all))
		-- an answer that is only the list line is not an empty answer: the list message follows
		local found = {}
		if #buys == 0 or text:find("%S") then PrintAnswer(text, wasLate, e.asked, found) end
		if AskedToMark(e.q) then
			if #found > 0 then
				local ok, err = pcall(MarkNow, found)
				if not ok then Say("地图标记出错：" .. Plain(err)) end
			else
				Say("回答里没有能标到地图上的位置（没有坐标，或者这张地图不能标）。")
			end
		end
		pending[pkt.id], late[pkt.id] = nil, nil
		if #buys > 0 then
			local ok, err = pcall(HandleBuy, buys[#buys], e.q)
			if not ok then Say("采购清单处理出错：" .. Plain(err)) end
		end
	end
	if not next(pending) then Mailbox.SetActive(false) end
end

-- Blizzard's own pre-send event: text typed in the DSH chat type is taken out of the edit box before anything is sent.
EventRegistry:RegisterCallback("ChatFrame.OnEditBoxPreSendText", function(_, editBox)
	if not editBox then return end
	local chatType = editBox:GetChatType()
	if chatType ~= KEY and chatType ~= KEY_T then
		-- a real chat message: remember where it went, for [填入聊天框]
		if type(chatType) == "string" then
			lastOut = { type = chatType }
			if chatType == "WHISPER" or chatType == "BN_WHISPER" then lastOut.tell = editBox:GetAttribute("tellTarget") end
			if chatType == "CHANNEL" then lastOut.channel = editBox:GetAttribute("channelTarget") end
		end
		return
	end
	local text = editBox:GetText()
	editBox:SetText("")      -- first: nothing may be left for SendChatMessage
	if issecretvalue and issecretvalue(text) then
		Say("这里的聊天被锁定（副本或战斗限制），DSH 频道暂时用不了。")
		return
	end
	text = strtrim(text or "")
	if text == "" then return end
	if chatType == KEY_T then
		pcall(editBox.AddHistoryLine, editBox, "/dsht " .. text)
		C_Timer.After(0, function() Core:Translate(text) end)
		return
	end
	pcall(editBox.AddHistoryLine, editBox, "/dsh " .. text)
	C_Timer.After(0, function() Core:Ask(text) end)
end, Core)

-- /dshq <question>: for macros (macro lines skip the pre-send event)
SLASH_DSHQ1 = "/dshq"
SlashCmdList.DSHQ = function(msg) Core:Ask(msg) end

-- /dshc status | voices | test | reset
SLASH_DSHC1 = "/dshc"
SlashCmdList.DSHC = function(msg)
	local word, rest = strtrim(msg or ""):match("^(%S*)%s*(.-)$")
	local handler = Core.commands[(word or ""):lower()]
	if handler then return handler(rest or "") end
	local cmd = strtrim(msg or ""):lower()
	if cmd == "voices" then
		local list, why = Voice.List()
		if not list then Say("取不到语音列表：" .. tostring(why)) return end
		Say(("游戏看到 %d 个语音："):format(#list))
		for _, v in ipairs(list) do Say(("  %s  %s"):format(tostring(v.voiceID), Plain(v.name))) end
	elseif cmd == "test" then
		if Send("ping", "ping") then Say("已发出测试，等桥接程序回话……") end
	elseif cmd == "reset" or cmd == "new" then
		if Send("reset", "reset") then Say("已请求开新对话……") end
	elseif cmd == "status" then
		local n = 0
		for _ in pairs(pending) do n = n + 1 end
		Say(("语音：%s · 回信：%s，下一个槽位 %d/%d，进程戳 %s · 等待中 %d"):format(
			Voice:Available() and "已找到 DSHBridge" or "|cffff6060没找到 DSHBridge|r",
			Mailbox.Phase(), Mailbox.Next(), Mailbox.POOL, Plain(Mailbox.Proc()), n))
	else
		Say("用法：输入 /dsh 进入 DSH 频道后直接打字提问（像 /s 一样会保持）；宏里用 /dshq 问题。")
		Say("/dshc test 测试链路 · /dshc reset 开新对话（也可以在频道里打“新对话”） · /dshc status 状态 · /dshc voices 列出语音")
		Say("翻译：输入 /dsht 进入 [DSH 翻译]（或 DSH 按钮菜单里的“帮我翻译”），打中文翻成英文、打英文翻成中文；点译文后面的 [填入聊天框] 放进原来的频道，按回车才发出去")
		Say("地图：回答里的 [地图标记] 链接点了才在地图上放游戏自带的标记（问题里说“标到地图”“帮我导航”“带我去”会直接标第一个）")
		Say("采购清单：DSH 列出要买的材料后，点 [加进 Auctionator] 或打 /dshc buy，才会放进 Auctionator 购物清单「" .. BUY_LIST .. "」（问题里说“加进购物清单”也行）")
		Say("快捷提问：点 DSH 按钮（也能进频道、开新对话；等回答时按钮旁显示“正在回复…”），或在 按键设置 › DSH 频道 绑快捷键 · /dshc add 问题 · /dshc del 编号 · /dshc list · /dshc button on|off|reset")
	end
end

-- driver: mailbox ticks and timeouts
local driver = CreateFrame("Frame")
local nextCheck = 0
driver:SetScript("OnUpdate", function()
	Mailbox.Tick()
	local now = GetTime()
	if now < nextCheck then return end
	nextCheck = now + 1
	for id, e in pairs(pending) do
		if e.t and now - e.t > TIMEOUT then
			pending[id], late[id] = nil, { asked = e.asked, q = e.q, kind = e.kind }
			Say("等了 150 秒没有回答。桥接程序在运行吗？（/dshc status）")
		end
	end
	if not next(pending) then Mailbox.SetActive(false) end
end)

driver:RegisterEvent("ADDON_LOADED")
driver:RegisterEvent("PLAYER_LOGIN")
driver:RegisterEvent("DISPLAY_SIZE_CHANGED")
driver:RegisterEvent("UI_SCALE_CHANGED")
driver:RegisterEvent("GX_RESTARTED")
pcall(driver.RegisterEvent, driver, "AUCTION_HOUSE_SHOW")
driver:SetScript("OnEvent", function(_, event, arg)
	if event == "ADDON_LOADED" and arg == "DSHChat" then
		DSHChatDB = DSHChatDB or {}
		DSHChatDB.mail = DSHChatDB.mail or {}
		-- a list still waiting for the AH from before a /reload or relog (search-term strings only)
		local p = DSHChatDB.buyPending
		if type(p) == "table" and #p > 0 and #p <= BUY_MAX then
			for _, t in ipairs(p) do if type(t) ~= "string" then p = nil break end end
		else
			p = nil
		end
		pendingAH, DSHChatDB.buyPending = p, p
		DSHChatDB.buyOff = nil            -- the old automatic-mode switch (lists are never added on their own now)
	elseif event == "PLAYER_LOGIN" then
		Mailbox.Start(DSHChatDB.mail, OnPacket)
		if ns.QuickMenu then
			local ok, err = pcall(ns.QuickMenu.Init)
			if not ok then Say("快捷提问按钮没加载：" .. tostring(err)) end
		end
		Voice:Available()
	elseif event == "AUCTION_HOUSE_SHOW" then
		-- a list made away from the AH: open it in Auctionator's Shopping tab once its tabs exist
		if pendingAH then
			C_Timer.After(0.5, function()
				local terms, api = pendingAH, AuctionatorAPI()
				if not (terms and api and AuctionHouseShown()) then return end
				local ok, how = pcall(function() local _, _, h = CreateList(api, terms, true) return h end)
				if ok and how == "open" then Say("采购清单已在 Auctionator 购物页「" .. BUY_LIST .. "」打开，买不买你自己点。") end
			end)
		end
	elseif event == "DISPLAY_SIZE_CHANGED" or event == "UI_SCALE_CHANGED" or event == "GX_RESTARTED" then
		Font.Rescale()
	end
end)
