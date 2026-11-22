-- Game -> PC channel: the game's text-to-speech API with the silent "DSHBridge" voice (voice/DSHBridgeTts.cs).
-- Windows hands the "spoken" text to that voice, which passes it to the bridge: nothing is drawn and nothing is heard.
-- Messages: "DSHB:<request id>:<part>/<parts>:<base64 of the request JSON>".
--
-- Adapted from Forever AI Companion's addon/ForeverAICompanion/Voice.lua (MIT, Copyright (c) 2026 lucasmenares).
local _, ns = ...

local Voice = {}
ns.Voice = Voice

Voice.CHUNK = 24000   -- base64 characters per spoken message (the game cuts one phrase at about 30 000)
Voice.VOLUME = 0

local floor, ceil = math.floor, math.ceil
local B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

function Voice.Base64(s)
	local out = {}
	for i = 1, #s, 3 do
		local a, b, c = s:byte(i, i + 2)
		local n = a * 65536 + (b or 0) * 256 + (c or 0)
		local c1, c2 = floor(n / 262144) % 64, floor(n / 4096) % 64
		local c3, c4 = floor(n / 64) % 64, n % 64
		out[#out + 1] = B64:sub(c1 + 1, c1 + 1) .. B64:sub(c2 + 1, c2 + 1)
			.. (b and B64:sub(c3 + 1, c3 + 1) or "=") .. (c and B64:sub(c4 + 1, c4 + 1) or "=")
	end
	return table.concat(out)
end

-- the installed voices, as { {voiceID, name}, ... } (or nil + reason)
function Voice.List()
	local get = C_VoiceChat and C_VoiceChat.GetTtsVoices
	if not get then return nil, "no-api" end
	local ok, list = pcall(get)
	if not ok or type(list) ~= "table" then return nil, tostring(list) end
	return list
end

function Voice:Find()
	for _, v in ipairs(Voice.List() or {}) do
		if type(v.name) == "string" and v.name:find("DSHBridge", 1, true) then return v.voiceID end
	end
	return nil
end

function Voice:Available()
	self.voiceID = self:Find()
	return self.voiceID ~= nil
end

-- SpeakText changed signature across game versions; remember what works.
function Voice:Speak(text, volume)
	local speak = C_VoiceChat and C_VoiceChat.SpeakText
	if not speak or not self.voiceID then return false end
	volume = volume or self.VOLUME
	if self.signature ~= "old" then
		-- (voiceID, text, rate, volume, overlap): overlap queues instead of cutting
		if pcall(speak, self.voiceID, text, 0, volume, true) then
			self.signature = "new"
			return true
		end
	end
	if self.signature ~= "new" then
		local dest = Enum and Enum.VoiceTtsDestination and Enum.VoiceTtsDestination.LocalPlayback or 1
		if pcall(speak, self.voiceID, text, dest, 0, volume) then
			self.signature = "old"
			return true
		end
	end
	return false
end

-- Sends a request string. Returns true when every part was spoken.
function Voice:Send(request, id)
	if not self.voiceID and not self:Available() then return false, "no-voice" end
	local data = Voice.Base64(request)
	local parts = ceil(#data / self.CHUNK)
	for i = 1, parts do
		local chunk = data:sub((i - 1) * self.CHUNK + 1, i * self.CHUNK)
		if not self:Speak(("DSHB:%s:%d/%d:%s"):format(id, i, parts, chunk)) then
			return false, "speak"
		end
	end
	return true
end
