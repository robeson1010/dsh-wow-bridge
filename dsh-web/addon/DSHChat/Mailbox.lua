-- Font mailbox: the bridge -> addon channel. mail\00001.ttf .. 01024.ttf stay empty until the bridge writes one packet
-- into a slot (bridge/lib/fontmail.mjs). Slots are read in order. The client caches a font by path until it exits
-- (/reload included) and does not cache a failed load, so an empty slot can be polled and a slot is read once per game
-- process. mail\proc.ttf holds a stamp of the game process: when it differs from the saved one, reading starts at slot 1.
-- Unlike Workshop, this mailbox only polls while a question waits for its answer.
--
-- Adapted from Wuxian Workshop's addon/WoWBridge/Mailbox.lua (MIT, Copyright (c) 2026 kk8o).
local _, ns = ...
local Font = ns.Font
local byte = string.byte

local M = {}
ns.Mailbox = M
M.POOL = 1024

local DIR = "Interface\\AddOns\\DSHChat\\mail\\"
local RESET_AFTER = 1.0     -- a FontString gets SetFont again this often while the slot is not readable (loading is
                            -- asynchronous; a SetFont sooner would start the load over)
local METERS = 10           -- FontStrings taking turns, so an empty slot is still tried every 0.1 s
local BAD_LIMIT = 8         -- a slot whose packet keeps failing its checks is skipped after this many tries
local PROC_WAIT = 5         -- seconds to wait for proc.ttf at login

local st                    -- { phase = "proc" | "idle" | "poll" | "full", meters, lastSet, slot, t0, db, onPacket, bad }

local function SlotPath(k)
	return DIR .. ("%05d.ttf"):format(k)
end

-- a DSH payload: "DB" | 1 | flags | slot (4) | part | parts | id length | id | text
function M.Parse(s)
	if #s < 11 or s:sub(1, 2) ~= "DB" or byte(s, 3) ~= 1 then return nil end
	local slot = ((byte(s, 5) * 256 + byte(s, 6)) * 256 + byte(s, 7)) * 256 + byte(s, 8)
	local idLen = byte(s, 11)
	if #s < 11 + idLen then return nil end
	return {
		slot = slot, part = byte(s, 9), parts = byte(s, 10),
		id = s:sub(12, 11 + idLen), text = s:sub(12 + idLen),
	}
end

local function Want(k)
	local now = GetTime()
	st.slot, st.bad = k, 0
	Font.Load(st.meters[1], SlotPath(k))
	st.lastSet[1] = now
	for i = 2, METERS do
		st.lastSet[i] = now - RESET_AFTER + RESET_AFTER / METERS * (i - 1)
	end
end

-- db: DSHChatDB.mail (keeps .proc and .next); onPacket(pkt) for every packet, in slot order
function M.Start(db, onPacket)
	db.next = db.next or 1
	st = { phase = "proc", meters = {}, lastSet = {}, db = db, onPacket = onPacket, t0 = GetTime(), active = false }
	for i = 1, METERS do st.meters[i] = Font.Meter() end
	Font.Load(st.meters[1], DIR .. "proc.ttf")
	st.lastSet[1] = GetTime()
end

function M.Next() return st and st.db.next or 1 end
function M.Phase() return st and st.phase or "off" end
function M.Proc() return st and st.proc or "?" end
function M.Full() return st and st.db.next > M.POOL end

-- poll only while something waits for an answer
function M.SetActive(on)
	if not st then return end
	st.active = on and true or false
	if st.phase == "idle" and st.active then
		if st.db.next > M.POOL then
			st.phase = "full"
		else
			st.phase = "poll"
			Want(st.db.next)
		end
	elseif st.phase == "poll" and not st.active then
		st.phase = "idle"
	end
end

function M.Tick()
	if not st then return end
	local now = GetTime()
	if st.phase == "proc" then
		local stamp = Font.Packet(st.meters[1])
		if stamp or now - st.t0 > PROC_WAIT then
			st.proc = stamp or "?"
			-- a stamp unlike the saved one: the game was restarted (or the bridge emptied the slots: "?"), every slot
			-- is unread again
			if stamp and stamp ~= st.db.proc then
				st.db.next = 1
				st.db.proc = stamp
			end
			st.phase = "idle"
			M.SetActive(st.active)
		elseif now - st.lastSet[1] >= RESET_AFTER then
			Font.Load(st.meters[1], DIR .. "proc.ttf")
			st.lastSet[1] = now
		end
		return
	end
	if st.phase ~= "poll" then return end
	local k = st.slot
	local low = k % 256
	for _, meter in ipairs(st.meters) do
		-- until slot k has loaded, a FontString still shows an earlier font: look at the slot number's low byte (data
		-- byte 11) first, then at the whole head
		local head = Font.Peek(meter, 11) == low and Font.Head(meter, 12)
		if head and head[5] == 68 and head[6] == 66
			and ((head[9] * 256 + head[10]) * 256 + head[11]) * 256 + head[12] == k then
			local s = Font.Packet(meter)
			local pkt = s and M.Parse(s)
			if pkt and pkt.slot == k then
				st.db.next = k + 1
				if k + 1 <= M.POOL then
					Want(k + 1)
				else
					st.phase = "full"
				end
				st.onPacket(pkt)
				return
			end
			st.bad = st.bad + 1
			if st.bad >= BAD_LIMIT then   -- a damaged packet: skip it rather than stall the mailbox
				st.db.next = k + 1
				Want(k + 1)
			end
			return
		end
	end
	for i, meter in ipairs(st.meters) do
		if now - st.lastSet[i] >= RESET_AFTER then
			Font.Load(meter, SlotPath(k))
			st.lastSet[i] = now
		end
	end
end
