-- CRC-16/CCITT-FALSE for the font packets.
-- From Wuxian Workshop's addon/WoWBridge/Codec.lua (MIT, Copyright (c) 2026 kk8o).
local _, ns = ...

local band, bxor, lshift = bit.band, bit.bxor, bit.lshift

local Codec = {}
ns.Codec = Codec

function Codec.CRC16(bytes, first, last)
	local crc = 0xFFFF
	for i = first, last do
		crc = bxor(crc, lshift(bytes[i], 8))
		for _ = 1, 8 do
			if band(crc, 0x8000) ~= 0 then
				crc = band(bxor(lshift(crc, 1), 0x1021), 0xFFFF)
			else
				crc = band(lshift(crc, 1), 0xFFFF)
			end
		end
	end
	return crc
end
