-- Font return channel: the bridge writes bytes into the advance widths of a TrueType font (bridge/lib/ttf.mjs).
-- A FontString on a pixel-exact frame loads the font and measures one glyph at a time: U+E000 and U+E001 calibrate
-- byte values 0 and 255, data byte k is glyph U+E002 + k. A packet is "WF", the payload length (2 bytes), the payload
-- and the CRC-16 of everything before it.
-- GetStringWidth reports the extent up to the last glyph's ink, not the sum of advances, so each glyph is measured
-- followed by a fixed tail glyph, whose position then depends on the measured glyph's advance.
--
-- From Wuxian Workshop's addon/WoWBridge/FontProbe.lua (MIT, Copyright (c) 2026 kk8o).
local _, ns = ...
local Codec = ns.Codec
local char, floor, abs = string.char, math.floor, math.abs

local Font = {}
ns.Font = Font
Font.SIZE = 64
Font.MAX_PACKET = 4096

local holder
local calGen = 0

-- UTF-8 of U+E000 + i
local function Glyph(i)
	local cp = 0xE000 + i
	return char(0xE0 + floor(cp / 4096), 0x80 + floor(cp / 64) % 64, 0x80 + cp % 64)
end

local TAIL = Glyph(0)

local function Holder()
	if not holder then
		holder = CreateFrame("Frame", nil, UIParent)
		holder:SetIgnoreParentScale(true)
		holder:SetSize(1, 1)
		holder:SetPoint("TOPLEFT")
		holder:SetAlpha(0)
	end
	local _, physH = GetPhysicalScreenSize()
	holder:SetScale(768 / physH)   -- one UI unit = one physical pixel: size 64 means 64 pixels
	calGen = calGen + 1
	return holder
end

-- after the physical size changed: one UI unit must stay one physical pixel, or bytes misread
function Font.Rescale()
	calGen = calGen + 1
	if holder then
		local _, physH = GetPhysicalScreenSize()
		holder:SetScale(768 / physH)
	end
end

function Font.Meter()
	local fs = Holder():CreateFontString(nil, "ARTWORK")
	fs:SetFontObject(GameFontNormal)
	fs:SetPoint("TOPLEFT")
	fs:SetWordWrap(false)
	fs:SetNonSpaceWrap(false)
	return fs
end

function Font.Load(fs, path, size)
	if fs.dshCal then fs.dshCal[1] = false end
	return pcall(fs.SetFont, fs, path, size or Font.SIZE, "")
end

local function Width(fs, i)
	if not pcall(fs.SetText, fs, Glyph(i) .. TAIL) then return nil end
	return fs:GetStringWidth()
end

-- (width of one byte step, width of byte 0); nil when this is not one of our fonts
function Font.Calibrate(fs)
	local w0, w255 = Width(fs, 0), Width(fs, 1)
	if not (w0 and w255) or w255 - w0 < 25 then return nil end
	return (w255 - w0) / 255, w0
end

function Font.Bytes(fs, step, w0, first, n, out)
	out = out or {}
	for k = first, first + n - 1 do
		local w = Width(fs, 2 + k)
		if not w then return nil, "text" end
		local r = floor((w - w0) / step + 0.5)
		if r < 0 or r > 255 then return nil, "range" end
		out[#out + 1] = r
	end
	return out
end

-- data byte k by the FontString's kept calibration, or nil: the cheapest look whether a new font is in
function Font.Peek(fs, k)
	local cal = fs.dshCal
	local step, w0
	if cal and cal[1] == calGen then
		step, w0 = cal[2], cal[3]
	else
		step, w0 = Font.Calibrate(fs)
		if not step then return nil end
		if cal then
			cal[1], cal[2], cal[3] = calGen, step, w0
		else
			fs.dshCal = { calGen, step, w0 }
		end
	end
	local w = Width(fs, 2 + k)
	if not w then return nil end
	local r = floor((w - w0) / step + 0.5)
	if r < 0 or r > 255 then return nil end
	return r
end

function Font.Head(fs, n)
	local step, w0 = Font.Calibrate(fs)
	if not step then return nil end
	return (Font.Bytes(fs, step, w0, 0, n))
end

-- the packet in the font the FontString has now: payload string, or nil + error code
function Font.Packet(fs)
	local step, w0 = Font.Calibrate(fs)
	if not step then return nil, "cal" end
	local b, err = Font.Bytes(fs, step, w0, 0, 4)
	if not b then return nil, err end
	if b[1] ~= 87 or b[2] ~= 70 then return nil, "magic" end   -- "WF"
	local len = b[3] * 256 + b[4]
	if len > Font.MAX_PACKET then return nil, "len" end
	b, err = Font.Bytes(fs, step, w0, 4, len + 2, b)
	if not b then return nil, err end
	if Codec.CRC16(b, 1, 4 + len) ~= b[5 + len] * 256 + b[6 + len] then return nil, "crc" end
	local s = {}
	for i = 5, 4 + len do s[#s + 1] = char(b[i]) end
	return table.concat(s)
end
