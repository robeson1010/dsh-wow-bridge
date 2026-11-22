"""Offline end-to-end test: the real bridge (echo mode) + the real DSHChat Lua in a mock WoW client.

The mock client measures text with the font files the bridge writes (advance widths from hmtx, ink of the last glyph),
caches a font by path once it loaded (like the client) and does not cache failed loads. The "spoken" text goes to the
bridge through a real named pipe. Run:  py -3.12 test/e2e_offline.py   (needs node and the vendored lupa)
"""
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, '..', 'compact-minimap', 'tools', 'vendor'))
from lupa.lua51 import LuaRuntime  # noqa: E402

PIPE = 'DSHBridgeTest'
ADDON_FILES = ['Codec.lua', 'Font.lua', 'Mailbox.lua', 'Voice.lua', 'Core.lua', 'QuickMenu.lua']


def advances(path):
    """advance widths (font units) of glyphs U+E000.. and units per em, or None when not a font of ours"""
    try:
        data = open(path, 'rb').read()
    except OSError:
        return None
    if len(data) < 12:
        return None
    n = struct.unpack_from('>H', data, 4)[0]
    tables = {}
    for i in range(n):
        tag, _, off, ln = struct.unpack_from('>4sIII', data, 12 + 16 * i)
        tables[tag] = (off, ln)
    upem = struct.unpack_from('>H', data, tables[b'head'][0] + 18)[0]
    num = struct.unpack_from('>H', data, tables[b'hhea'][0] + 34)[0]
    hm = tables[b'hmtx'][0]
    adv = [struct.unpack_from('>H', data, hm + 4 * g)[0] for g in range(num)]
    return adv[2:], upem


class Client:
    def __init__(self, addons):
        self.addons = addons
        self.clock = 1000.0
        self.cache = {}            # path -> (advances, upem): the client keeps every font it loaded until it exits
        self.spoken = []
        self.chat = []

    def real(self, wow_path):
        rel = wow_path.replace('\\', '/').split('Interface/AddOns/', 1)[1]
        return os.path.join(self.addons, rel)

    def set_font(self, fs, path, size, flags):
        if isinstance(path, bytes):
            path = path.decode('utf-8')
        key = path.lower()
        if key not in self.cache:
            got = advances(self.real(path))
            if got is None:
                return False      # a failed load: not cached, the FontString keeps what it had
            self.cache[key] = got
        fs['font'] = self.cache[key]
        fs['size'] = size
        return True

    def width(self, fs, text):
        font = fs['font']
        if isinstance(text, bytes):
            text = text.decode('utf-8')
        if font is None:
            return 7.0 * len(text)
        adv, upem = font
        cps = [ord(c) for c in text]
        total = 0.0
        for k, cp in enumerate(cps):
            i = cp - 0xE000
            if i < 0 or i >= len(adv):
                return 0.0
            # the extent ends at the last glyph's ink (64 units wide), not its advance
            total += (64 if k == len(cps) - 1 else adv[i]) * fs['size'] / upem
        return total


def make_lua(client):
    lua = LuaRuntime(unpack_returned_tuples=True, encoding=None)
    g = lua.globals()
    # bit (BitOp) for Lua 5.1, enough for CRC-16
    lua.execute(b'''
      bit = {}
      local function tobits(a) local t = {} for i = 1, 32 do t[i] = a % 2; a = math.floor(a / 2) end return t end
      local function frombits(t) local a = 0 for i = 32, 1, -1 do a = a * 2 + t[i] end return a end
      local function op(f) return function(a, b) a, b = a % 4294967296, b % 4294967296
        local x, y, r = tobits(a), tobits(b), {} for i = 1, 32 do r[i] = f(x[i], y[i]) end return frombits(r) end end
      bit.band = op(function(x, y) return (x == 1 and y == 1) and 1 or 0 end)
      bit.bxor = op(function(x, y) return x ~= y and 1 or 0 end)
      bit.bor = op(function(x, y) return (x == 1 or y == 1) and 1 or 0 end)
      function bit.lshift(a, n) return (a * 2 ^ n) % 4294967296 end
      function bit.rshift(a, n) return math.floor((a % 4294967296) / 2 ^ n) end
      function strtrim(s) return (s:gsub("^%s+", ""):gsub("%s+$", "")) end
      function issecretvalue() return false end
    ''')
    py = lua.table()
    py.set_font = client.set_font
    py.width = client.width
    py.now = lambda: client.clock
    py.speak = lambda text: client.spoken.append(bytes(text).decode('utf-8'))
    py.chat = lambda text: client.chat.append(bytes(text).decode('utf-8'))
    g.PY = py
    lua.execute(b'''
      local function noop() end
      local FrameMT = {}
      FrameMT.__index = function(t, k) return rawget(FrameMT, k) or (type(k) == "string" and k:match("^%u") and noop) or nil end   -- any other frame method (Capitalized): no-op; fields stay nil
      for _, name in ipairs({"SetIgnoreParentScale","SetSize","SetPoint","SetAlpha","SetScale","RegisterEvent"}) do FrameMT[name] = noop end
      function FrameMT:Show() self.shown = true end
      function FrameMT:Hide() self.shown = false end
      function FrameMT:SetShown(v) self.shown = v and true or false end
      function FrameMT:IsVisible() return self.shown ~= false end
      function FrameMT:IsShown() return self.shown ~= false end
      function FrameMT:GetPoint() return "BOTTOMLEFT", UIParent, "BOTTOMLEFT", 500, 300 end
      function FrameMT:SetScript(which, fn) self.scripts[which] = fn end
      function FrameMT:CreateFontString()
        local fs = { font = nil, size = 0, text = "" }
        function fs:SetFontObject() end
        function fs:SetPoint() end
        function fs:SetWordWrap() end
        function fs:SetNonSpaceWrap() end
        function fs:SetFont(path, size, flags) return PY.set_font(self, path, size, flags) end
        function fs:SetText(t) self.text = t end
        function fs:GetStringWidth() return PY.width(self, self.text) end
        function fs:GetFont() return nil end
        function fs:Show() self.shown = true end
        function fs:Hide() self.shown = false end
        function fs:SetTextColor() end
        function fs:ClearAllPoints() end
        return fs
      end
      FRAMES = {}
      function CreateFrame() local f = setmetatable({ scripts = {} }, FrameMT) FRAMES[#FRAMES + 1] = f return f end
      UIParent = CreateFrame()
      GameFontNormal = {}
      function GetPhysicalScreenSize() return 1920, 1080 end
      function GetTime() return PY.now() end
      function time() return math.floor(os.time()) end
      TIMERS = {}
      C_Timer = { After = function(_, fn) TIMERS[#TIMERS + 1] = fn end }
      C_VoiceChat = {
        GetTtsVoices = function() return { { voiceID = 0, name = "Microsoft David" }, { voiceID = 3, name = "DSHBridge" } } end,
        SpeakText = function(id, text, rate, volume, overlap) assert(id == 3) PY.speak(text) end,
      }
      DEFAULT_CHAT_FRAME = { AddMessage = function(_, msg) PY.chat(msg) end }
      ChatTypeInfo = setmetatable({}, { __index = {} })
      SlashCmdList = {}
      CALLBACKS = {}
      EventRegistry = { RegisterCallback = function(_, ev, fn, owner) CALLBACKS[ev] = { fn, owner } end }
      function UnitName() return "Tester" end
      function GetRealmName() return "Forever" end
      function UnitLevel() return 12 end
      function UnitClass() return "Warrior" end
      function UnitRace() return "Human" end
      function GetRealZoneText() return "Westfall" end
      function GetSubZoneText() return "Sentinel Hill" end
      C_Map = { GetBestMapForUnit = function() return 1436 end,
        GetPlayerMapPosition = function() return { GetXY = function() return 0.521, 0.473 end } end }
      VESSEL_LINK = "|cnIQ1:|Hitem:7866::::::::57:1488::11:::::::|h[Empty Thaumaturgy Vessel]|h|r"
      LOAD_REQUESTS = {}
      C_Item = {
        GetItemInfo = function(id)
          if id == 7866 or (type(id) == "string" and id:find("^item:7866[:|]")) then
            return "Empty Thaumaturgy Vessel", VESSEL_LINK, 1, 1, 0, "Quest", "Quest", 1, "", 134776, 0, 12, 0, 4
          end
          return nil
        end,
        RequestLoadItemDataByID = function(id) LOAD_REQUESTS[#LOAD_REQUESTS + 1] = id end,
      }
      C_TooltipInfo = {
        GetHyperlink = function(link)
          assert(type(link) == "string" and link:find("^item:7866"), "tooltip asked for " .. tostring(link))
          return { lines = {
            { leftText = "Empty Thaumaturgy Vessel" },
            { leftText = "|cffffffffQuest Item|r" },
            { leftText = "Unique" , rightText = "|cff00ff00x1|r" },
          } }
        end,
      }
      -- Blizzard_Menu: descriptions record what the generator builds; LAST_MENU is the last root opened
      local Desc = {}
      Desc.__index = Desc
      local function NewDesc(kind, text, cb) return setmetatable({ kind = kind, text = text, cb = cb, enabled = true, entries = {} }, Desc) end
      function Desc:CreateTitle(text) local d = NewDesc("title", text) table.insert(self.entries, d) return d end
      function Desc:CreateButton(text, cb) local d = NewDesc("button", text, cb) table.insert(self.entries, d) return d end
      function Desc:CreateDivider() local d = NewDesc("divider") table.insert(self.entries, d) return d end
      function Desc:SetEnabled(v) self.enabled = v end
      function Desc:SetTooltip(fn) self.tooltip = fn end
      function Desc:SetScrollMode() self.scroll = true end
      MENU_SEQ = 0
      local function MenuObj() MENU_SEQ = MENU_SEQ + 1 local o = { seq = MENU_SEQ, open = true, SetClosedCallback = function(self, fn) self.closed = fn end, Close = function(self) self.open = false if self.closed then self.closed() end end } LAST_MENU_OBJ = o return o end
      MenuUtil = {
        CreateRootMenuDescription = function() return NewDesc("root") end,
        CreateContextMenu = function(owner, gen) local r = NewDesc("root") gen(owner, r) LAST_MENU = r return MenuObj() end,
      }
      MenuVariants = { GetDefaultContextMenuMixin = function() return {} end }
      Menu = {
        PopulateDescription = function(gen, owner, root) gen(owner, root) end,
        GetManager = function() return { OpenMenu = function(_, owner, root) LAST_MENU = root return MenuObj() end } end,
      }
      function CreateAnchor() return {} end
      ChatFrameUtil = { OpenChat = function(text) OPENED_CHAT = text end }
      function PlaySound() end
      SOUNDKIT = { IG_MAINMENU_OPTION_CHECKBOX_ON = 1 }
      function GameTooltip_SetTitle() end
      -- tooltips: HOVER_LINK set by the test = the item under the mouse
      Enum = Enum or {}
      Enum.TooltipDataType = { Item = 0 }
      -- TT_FILLING: Blizzard runs tooltip post-calls after storing the data but before Show()
      GameTooltip = { IsShown = function() return HOVER_LINK ~= nil and not TT_FILLING end, IsTooltipType = function(_, t) return t == 0 end }
      ItemRefTooltip = { IsShown = function() return false end }
      TooltipUtil = { GetDisplayedItem = function() return "x", HOVER_LINK, 7866 end }
      TOOLTIP_POSTCALLS = {}
      TooltipDataProcessor = { AddTooltipPostCall = function(_, fn) table.insert(TOOLTIP_POSTCALLS, fn) end }
      -- professions: Tailoring (child skill line 2948 -> 197) and Herbalism (no crafting page)
      function GetProfessions() return 1, nil, 2 end
      function GetProfessionInfo(i)
        if i == 1 then return "Tailoring", 0, 150, 300, 0, 0, 2948 end
        return "Herbalism", 0, 80, 150, 0, 0, 182
      end
    ''')
    ns = lua.table()
    for name in ADDON_FILES:
        src = open(os.path.join(ROOT, 'dsh-web', 'addon', 'DSHChat', name), 'rb').read()
        fn = lua.execute(b'return function(src, name, ns) return assert(loadstring(src, name))("DSHChat", ns) end')
        fn(src, name.encode(), ns)
    return lua, ns


class Harness:
    def __init__(self):
        self.tmp = tempfile.mkdtemp(prefix='dshb-')
        self.addons = os.path.join(self.tmp, 'AddOns')
        self.data = os.path.join(self.tmp, 'data')
        os.makedirs(self.addons)
        bridge = os.path.join(ROOT, 'bridge', 'bridge.mjs')
        out = subprocess.run(['node', bridge, 'install', '--addons', self.addons, '--force'], capture_output=True, text=True, encoding='utf-8')
        assert out.returncode == 0, out.stderr
        self.proc = subprocess.Popen(['node', bridge, 'run', '--echo', '--addons', self.addons, '--data', self.data,
                                      '--pipe', PIPE, '--no-game-watch'],
                                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding='utf-8')
        self.client = Client(self.addons)
        self.lua, self.ns = make_lua(self.client)
        g = self.lua.globals()
        self.g = g
        self.driver = g.FRAMES[len(g.FRAMES)]
        on_event = self.driver.scripts[b'OnEvent']
        on_event(self.driver, b'ADDON_LOADED', b'DSHChat')
        on_event(self.driver, b'PLAYER_LOGIN')
        deadline = time.time() + 10
        while not os.path.exists(r'\\.\pipe\%s' % PIPE):
            assert time.time() < deadline, 'the bridge did not open its pipe'
            time.sleep(0.1)

    def tick(self, seconds):
        steps = int(seconds / 0.05)
        for _ in range(steps):
            self.client.clock += 0.05
            while len(self.g.TIMERS) > 0:
                fn = self.g.TIMERS[1]
                self.lua.execute(b'table.remove(TIMERS, 1)')
                fn()
            self.driver.scripts[b'OnUpdate'](self.driver, 0.05)
            self.flush_voice()

    def flush_voice(self):
        while self.client.spoken:
            text = self.client.spoken.pop(0)
            with open(r'\\.\pipe\%s' % PIPE, 'wb') as p:
                p.write(text.encode('utf-8'))

    def type_in_channel(self, text, chat_type=b'DSH'):
        box = self.lua.table()
        box.chatType = chat_type
        box.text = text.encode('utf-8')
        self.lua.execute(b'''
          function MAKEBOX(b)
            function b:GetChatType() return self.chatType end
            function b:GetText() return self.text end
            function b:SetText(t) self.text = t end
            function b:AddHistoryLine() end
            return b
          end''')
        box = self.g.MAKEBOX(box)
        cb = self.g.CALLBACKS[b'ChatFrame.OnEditBoxPreSendText']
        cb[1](cb[2], box)
        assert box.text == b'', 'the edit box must be emptied before anything is sent'

    def wait_chat(self, needle, seconds=15):
        deadline = time.time() + seconds
        while time.time() < deadline:
            self.tick(0.25)
            for line in self.client.chat:
                if needle in line:
                    return line
            time.sleep(0.05)
        raise AssertionError(f'no chat line with {needle!r}; chat so far: {self.client.chat}')

    def close(self):
        self.proc.terminate()
        try:
            out = self.proc.communicate(timeout=5)[0]
        except subprocess.TimeoutExpired:
            self.proc.kill()
            out = self.proc.communicate()[0]
        shutil.rmtree(self.tmp, ignore_errors=True)
        return out


def main():
    h = Harness()
    ok = True
    try:
        h.tick(6)  # proc phase at login (proc.ttf says TEST)
        assert h.ns.Mailbox.Proc() == b'TEST', h.ns.Mailbox.Proc()

        # 1. a question typed in the [DSH] channel
        h.type_in_channel('我在哪？')
        line = h.wait_chat('回声测试')
        assert '我在哪？' in line, line
        print('OK  question -> voice -> pipe -> bridge -> font slot -> chat:', line)
        assert any('Westfall' in l and '52.1' in l for l in h.client.chat), 'character context should come back in the echo'

        # 2. /dshc test (ping)
        h.client.chat.clear()
        h.g.SlashCmdList[b'DSHC'](b'test')
        print('OK  ping:', h.wait_chat('链路正常'))

        # 3. a long question: the echo needs several slots (multi-part answer)
        h.client.chat.clear()
        long_q = '长' * 2000 + '||cffff0000红||r'  # a typed | is || in the edit box
        h.type_in_channel(long_q)
        h.wait_chat('回声测试', 30)
        joined = ''.join(h.client.chat)
        assert joined.count('长') >= 2000, 'the whole long answer should arrive'
        assert '||cffff0000' in joined, 'a | in the answer must be escaped'
        print('OK  long answer across slots, | escaped; next slot now', h.ns.Mailbox.Next())

        # 4. the fallback folder: a message the voice wrote while the pipe was not there
        h.client.chat.clear()
        sent_before = len(h.client.spoken)
        h.g.SlashCmdList[b'DSHQ'](b'from the inbox')
        while len(h.client.spoken) == sent_before and not h.client.spoken:
            h.tick(0.05)
        text = h.client.spoken.pop()
        os.makedirs(os.path.join(h.data, 'tts-inbox'), exist_ok=True)
        tmp = os.path.join(h.data, 'tts-inbox', '0001.tmp')
        open(tmp, 'w', encoding='utf-8').write(text)
        os.replace(tmp, tmp[:-4] + '.txt')
        print('OK  inbox fallback:', h.wait_chat('收到「from the inbox」'))

        # 5. an item link in the question (the exact link from the in-game screenshot)
        h.client.chat.clear()
        link = h.g.VESSEL_LINK.decode('utf-8')
        h.flush_voice = lambda: None          # hold the spoken text to look at the request first
        h.type_in_channel(link + ' 啥任务用的')
        h.tick(0.1)
        spoken = h.client.spoken.pop()
        req = json.loads(__import__('base64').b64decode(spoken.split(':', 3)[3]).decode('utf-8'))
        assert req['q'] == '[Empty Thaumaturgy Vessel] 啥任务用的', req['q']
        item = req['links'][0]
        assert item['type'] == 'item' and item['id'] == 7866 and item['name'] == 'Empty Thaumaturgy Vessel', item
        assert item['tooltip'] == ['Empty Thaumaturgy Vessel', 'Quest Item', 'Unique    x1'], item['tooltip']
        echo = next(l for l in h.client.chat if '你：' in l)
        assert '|Hitem:7866' in echo and '||H' not in echo, f'the echo must keep the link clickable: {echo!r}'
        print('OK  link: echo keeps it clickable, DSH gets', repr(req['q']), 'and the item details')
        with open(r'\\.\pipe\%s' % PIPE, 'wb') as p:
            p.write(spoken.encode('utf-8'))
        del h.flush_voice                      # back to the class method
        line = h.wait_chat('链接：')
        assert '|Hitem:7866' in line and '||H' not in line, f'an item token in the answer must become the link: {line!r}'
        print('OK  {{item:7866|...}} in the answer became a clickable link:', line)

        # 6. a token with the wrong name for its id stays plain text; an unknown id asks the client to load it
        render = h.ns.Core.RenderLine
        out = render('试试 {{item:7866|Wrong Name}} 和 {{item:999|Unknown}} 还有 a|b'.encode('utf-8')).decode('utf-8')
        assert out == '试试 [Wrong Name] 和 [Unknown] 还有 a||b', out
        assert list(h.g.LOAD_REQUESTS.values()) == [999], 'an unknown id should be requested from the client'
        out = render(b'{{item:7866|empty thaumaturgy vessel}}').decode('utf-8')
        assert out == link, out
        print('OK  wrong name -> plain text, unknown id -> plain + load request, name match is case-insensitive')

        # 7. names in brackets and a full-width separator still match; the player's own link wins for linked items
        out = render('{{item:7866|[Empty Thaumaturgy Vessel]}} {{item:7866｜Empty Thaumaturgy Vessel}}'.encode('utf-8')).decode('utf-8')
        assert out == link + ' ' + link, out
        monkey = '|cff1eff00|Hitem:4242:0:0:0:0:0:7:0:57|h[Ring of the Monkey]|h|r'
        plain, links, asked = h.ns.Core.Unlink(('看看 ' + monkey + ' 和 ' + link).encode('utf-8'))
        assert plain.decode('utf-8') == '看看 [Ring of the Monkey] 和 [Empty Thaumaturgy Vessel]', plain
        assert links[1].name == b'Ring of the Monkey', links[1].name
        assert asked[4242].decode('utf-8') == monkey and asked[7866].decode('utf-8') == link, dict(asked)
        out = render(b'{{item:4242|Ring}}', asked).decode('utf-8')
        assert out == monkey, out
        out = render('{{item:7866|空的魔法瓶}}'.encode('utf-8')).decode('utf-8')
        assert out == link, f'a Chinese name cannot be compared on an English client: the id is trusted: {out!r}'
        print('OK  [name] and full-width separator match; a random-suffix link the player sent comes back unchanged; Chinese name -> link')

        # 8. prices are fetched online only: even with Auctionator loaded, no local price goes out; the faction does
        h.lua.execute(b'''
          C_AddOns = { IsAddOnLoaded = function(name) return name == "Auctionator" end }
          function UnitFactionGroup() return "Horde" end
          Auctionator = { API = { v1 = { GetAuctionPriceByItemID = function() return 1234 end } } }''')
        h.flush_voice = lambda: None
        h.client.spoken.clear()
        h.type_in_channel(link + ' 现在多少钱')
        h.tick(0.1)
        req = json.loads(__import__('base64').b64decode(h.client.spoken.pop().split(':', 3)[3]).decode('utf-8'))
        assert 'auction' not in req['links'][0] and 'auctionKey' not in req['ctx'], req
        assert req['ctx'].get('faction') == 'Horde', req['ctx']
        del h.flush_voice
        print('OK  online prices only: no local Auctionator data in the request; faction sent for the price page')

        # 9. quick questions: menu content, sending, hovered item, custom questions
        g = h.g
        def sent_q():
            req = json.loads(__import__('base64').b64decode(h.client.spoken.pop().split(':', 3)[3]).decode('utf-8'))
            return req
        def items(d):
            src = g.LAST_MENU if d is None else d
            return [src.entries[i] for i in range(1, len(src.entries) + 1)]
        def text(d):
            return (d.text or b'').decode('utf-8')
        h.flush_voice = lambda: None
        def open_menu():        # in game, picking an entry closes the menu (closed callback); a second Toggle would close it
            if g.LAST_MENU_OBJ is not None:
                g.LAST_MENU_OBJ.Close(g.LAST_MENU_OBJ)
            g.DSHChat_ToggleQuickMenu()
        assert g.DSHChatDB.quick.shown is True and len(g.DSHChatDB.quick.questions) == 0, 'Init made the saved settings'
        open_menu()
        top = items(None)
        labels = [(x.kind.decode(), text(x)) for x in top]
        assert labels[0] == ('title', 'DSH 快捷提问'), labels
        assert labels[1:5] == [('button', '进入 DSH 频道（打字提问）'), ('button', '帮我翻译（中文↔英文）'), ('button', '开新对话（/dshc reset）'), ('divider', '')], labels
        assert [l[1] for l in labels[5:8]] == ['我现在该做什么？', '附近有什么任务？', '这里适合刷什么？'], labels
        market = top[8]
        assert text(market) == '行情：鼠标指着的物品' and market.enabled is False, 'no item hovered: greyed out'
        craft = top[9]
        sub = [(x.kind.decode(), text(x)) for x in items(craft)]
        assert sub[0] == ('button', 'Tailoring  150/300') and sub[1][0] == 'divider', sub   # own profession first, child id 2948 -> 197
        assert '裁缝' not in [s[1] for s in sub[2:]] and len(sub) == 2 + 8, sub           # the other 8, herbalism skipped
        assert text(top[11]).startswith('自定义问题') and top[11].enabled is False and len(top) == 12, labels
        # 进入 DSH 频道: the chat box opens with "/dsh " (the edit box turns that into the DSH chat type)
        top[1].cb()
        assert g.OPENED_CHAT == b'/dsh ', g.OPENED_CHAT
        top[2].cb()
        assert g.OPENED_CHAT == b'/dsht ', '帮我翻译 opens the [DSH 翻译] channel'
        # a fixed question; a double click sends once
        h.client.spoken.clear()
        btn = [f for f in g.FRAMES.values() if f.scripts[b'OnClick']][0]
        status = btn.status
        h.client.clock += 151               # earlier checks' unanswered questions time out first
        h.driver.scripts[b'OnUpdate'](h.driver, 0.05)
        status.scripts[b'OnUpdate'](status)
        assert status.label.shown is False, 'nothing waiting: no status'
        top[5].cb(); top[5].cb()
        assert len(h.client.spoken) == 1 and sent_q()['q'] == '我现在该做什么？'
        # "正在回复… N 秒" beside the button while it waits
        h.client.clock += 6.2
        status.scripts[b'OnUpdate'](status)
        assert status.label.shown is True and status.label.text.decode('utf-8') == '正在回复… 6 秒', status.label.text
        # the craft submenu entry for the player's own profession
        h.client.clock += 2
        items(craft)[0].cb()
        assert sent_q()['q'] == '制作利润：裁缝 现在做什么拿去拍卖行卖最赚钱？'
        # the hovered-item key binding
        g.HOVER_LINK = link.encode('utf-8')
        g.DSHChat_AskHoveredMarket()
        req = sent_q()
        assert req['q'] == '行情：[Empty Thaumaturgy Vessel] 现在多少钱，适合买还是卖？' and req['links'][0]['id'] == 7866, req
        # the tooltip post-call remembers the item; the menu (opened from the button, tooltip gone) still offers it
        g.TT_FILLING = True                 # the post-call runs while the tooltip is still hidden
        g.TOOLTIP_POSTCALLS[1](g.GameTooltip)
        g.TT_FILLING = False
        g.HOVER_LINK = None
        open_menu()
        m = items(None)[8]
        assert text(m) == '行情：[Empty Thaumaturgy Vessel]' and m.enabled is True, text(m)
        h.client.clock += 2
        m.cb()
        assert '[Empty Thaumaturgy Vessel]' in sent_q()['q']
        h.client.clock += 31                # older than 30 s: no longer offered
        open_menu()
        assert items(None)[8].enabled is False
        # nothing hovered: the key says so
        h.client.chat.clear()
        g.DSHChat_AskHoveredMarket()
        assert any('鼠标没有指着物品' in l for l in h.client.chat), h.client.chat
        # /dshc add keeps the link's case (not lowercased), list, del, limits
        g.SlashCmdList[b'DSHC'](('add ' + link + ' 拿来做什么').encode('utf-8'))
        assert g.DSHChatDB.quick.questions[1].decode('utf-8') == link + ' 拿来做什么'
        g.SlashCmdList[b'DSHC'](b'add')
        assert any('用法：/dshc add' in l for l in h.client.chat)
        open_menu()
        custom = items(None)[11]
        assert text(custom) == '[Empty Thaumaturgy Vesse…' and custom.enabled is not False, text(custom)   # 24 chars; tooltip has it all
        h.client.clock += 2
        custom.cb()
        assert sent_q()['q'] == '[Empty Thaumaturgy Vessel] 拿来做什么'
        h.client.chat.clear()
        g.SlashCmdList[b'DSHC'](b'list')
        assert any(l.endswith('1. ' + link + ' 拿来做什么') for l in h.client.chat), h.client.chat
        g.SlashCmdList[b'DSHC'](b'del 9')
        assert any('用法：/dshc del' in l for l in h.client.chat)
        g.SlashCmdList[b'DSHC'](b'del 1')
        assert len(g.DSHChatDB.quick.questions) == 0
        g.SlashCmdList[b'DSHC'](b'button off')
        assert g.DSHChatDB.quick.shown is False
        g.SlashCmdList[b'DSHC'](b'button reset')
        assert g.DSHChatDB.quick.shown is True
        # the key opens the menu at the cursor; a DSH button click then moves it under the button; a second click closes it
        g.LAST_MENU_OBJ.Close(g.LAST_MENU_OBJ)
        g.DSHChat_ToggleQuickMenu()
        key_menu = g.LAST_MENU_OBJ
        btn = [f for f in g.FRAMES.values() if f.scripts[b'OnClick']][0]
        btn.scripts[b'OnClick'](btn)
        btn_menu = g.LAST_MENU_OBJ
        assert key_menu.open is False and btn_menu.seq == key_menu.seq + 1 and btn_menu.open, 'button click moved the menu'
        btn.scripts[b'OnClick'](btn)
        assert btn_menu.open is False and g.LAST_MENU_OBJ.seq == btn_menu.seq, 'second click closed it, nothing new opened'
        g.DSHChat_ToggleQuickMenu()
        assert g.LAST_MENU_OBJ.seq == btn_menu.seq + 1 and g.LAST_MENU_OBJ.open, 'key opens it again'
        # several waiting: counted
        h.client.clock += 0.3
        status.scripts[b'OnUpdate'](status)
        assert '个问题）' in status.label.text.decode('utf-8'), status.label.text
        # 开新对话
        open_menu()
        h.client.clock += 2
        items(None)[3].cb()
        assert sent_q()['type'] == 'reset'
        # all time out (150 s): the status goes away
        h.client.clock += 151
        h.driver.scripts[b'OnUpdate'](h.driver, 0.05)
        status.scripts[b'OnUpdate'](status)
        assert status.label.shown is False, 'status cleared after the timeout'
        del h.flush_voice
        print('OK  quick menu: channel + reset entries, fixed questions, own profession first, hovered item (key + menu), custom questions, waiting status')

        # 10. a shopping list in the answer -> Auctionator (the echo bridge sends the typed token straight back)
        h.lua.execute('''
          ITEMS = { [14047] = "Runecloth", [7866] = "Empty Thaumaturgy Vessel", [2321] = "Fine Thread" }
          LATE_ITEMS = {}          -- id -> lookups before the client "knows" it
          local base = C_Item.GetItemInfo
          C_Item.GetItemInfo = function(id)
            if type(id) == "number" and ITEMS[id] then
              if (LATE_ITEMS[id] or 0) > 0 then LATE_ITEMS[id] = LATE_ITEMS[id] - 1 return nil end
              return ITEMS[id], "|cffffffff|Hitem:" .. id .. "::::::::|h[" .. ITEMS[id] .. "]|h|r"
            end
            return base(id)
          end
          LISTS = {}
          CLICKS = 0
          AuctionatorTabs_Shopping = { Click = function() CLICKS = CLICKS + 1 end }
          AuctionHouseFrame = { IsShown = function() return AH_OPEN == true end }
          Auctionator = { API = { v1 = {
            ConvertToSearchString = function(caller, term)
              assert(caller == "DSHChat" and term.isExact == true)
              return '"' .. term.searchString .. '";;;;;;;;;;;;;' .. term.quantity
            end,
            CreateShoppingList = function(caller, name, terms)
              assert(caller == "DSHChat")
              local copy = {} for i, t in ipairs(terms) do copy[i] = t end
              LISTS[#LISTS + 1] = { name = name, terms = copy, ah = AH_OPEN == true, clicks = CLICKS }
              EXPANDED_NAME = OTHER_LIST or name     -- the Shopping tab expands the imported list (unless another wins)
            end,
          } } }
          CLEARED = 0
          AuctionatorShoppingFrame = {
            ListsContainer = { GetExpandedList = function() return { GetName = function() return EXPANDED_NAME end } end },
            SearchOptions = { SearchString = { ClearFocus = function() CLEARED = CLEARED + 1 end } },
          }
          function GetCurrentKeyBoardFocus() return FOCUS end
          AuctionatorBuyCommodityFrame = { IsShown = function() return BUYING == true end }'''.encode('utf-8'))
        lists = lambda: [(l.name.decode('utf-8'), [t.decode('utf-8') for t in l.terms.values()]) for l in h.g.LISTS.values()]
        link_cb = h.g.CALLBACKS[b'SetItemRef']
        click = lambda n: link_cb[1](link_cb[2], f'addon:DSHChat:buy:{n}'.encode(), b'[x]', b'LeftButton')
        on_event = h.driver.scripts[b'OnEvent']
        # an answer with a list: the line is hidden, the list is shown with a link, NOTHING goes into Auctionator yet
        h.client.chat.clear()
        h.type_in_channel('做绷带 {{buy:厚符文布绷带×5｜14047×10，{{item:2321|Fine Thread}} x 3、999×2, 14047*4}}')
        answer = h.wait_chat('回声测试')
        assert '{{buy' not in answer and '收到「做绷带 」' in answer, f'the buy line is taken out of the answer: {answer!r}'
        line = h.wait_chat('点它才加')
        assert len(h.g.LISTS) == 0, 'not added before the player confirms'
        assert '「厚符文布绷带×5」' in line and '|Hitem:14047' in line and '×14' in line and '1 个物品 ID 游戏里查不到：item:999' in line, line
        assert '|Haddon:DSHChat:buy:1|h[加进 Auctionator]|h' in line, line
        # the player clicks [加进 Auctionator] away from the AH: the list is made and waits for the AH (saved for /reload)
        h.client.chat.clear()
        click(1)
        h.tick(0.1)
        assert lists() == [('DSH 采购', ['"Runecloth";;;;;;;;;;;;;14', '"Fine Thread";;;;;;;;;;;;;3'])], lists()
        assert h.g.LISTS[1].ah is False and h.g.CLICKS == 0, 'away from the AH: no tab click'
        assert any('已加进 Auctionator' in l and '下次打开拍卖行' in l for l in h.client.chat), h.client.chat
        assert [t.decode('utf-8') for t in h.g.DSHChatDB.buyPending.values()] == lists()[0][1], 'pending list saved for /reload'
        # the auction house opens: the list is opened in the Shopping tab once, then forgotten
        h.g.AH_OPEN = True
        h.client.chat.clear()
        on_event(h.driver, b'AUCTION_HOUSE_SHOW')
        h.tick(0.1)
        assert len(h.g.LISTS) == 2 and h.g.LISTS[2].ah is True and h.g.LISTS[2].clicks == 1, 'reopened at the AH after the tab click'
        assert h.g.CLEARED == 1, 'the automatic tab click gives the keyboard back'
        assert any('购物页「DSH 采购」打开' in l for l in h.client.chat), h.client.chat
        assert h.g.DSHChatDB.buyPending is None
        on_event(h.driver, b'AUCTION_HOUSE_SHOW')
        h.tick(0.1)
        assert len(h.g.LISTS) == 2, 'a pending list opens only once'
        # after a /reload the saved pending list is picked up again (ADDON_LOADED reads DSHChatDB.buyPending)
        h.lua.execute(b'DSHChatDB.buyPending = { [["Saved";;;;;;;;;;;;;7]] }')
        on_event(h.driver, b'ADDON_LOADED', b'DSHChat')
        on_event(h.driver, b'AUCTION_HOUSE_SHOW')
        h.tick(0.1)
        assert lists()[-1] == ('DSH 采购', ['"Saved";;;;;;;;;;;;;7']) and h.g.DSHChatDB.buyPending is None, lists()
        # another addon's list wins the Shopping tab: the player is told where ours is
        h.g.OTHER_LIST = b'ProfLevelHelper: Tailoring'
        h.lua.execute(b'DSHChatDB.buyPending = { [["Saved";;;;;;;;;;;;;7]] }')
        on_event(h.driver, b'ADDON_LOADED', b'DSHChat')
        h.client.chat.clear()
        on_event(h.driver, b'AUCTION_HOUSE_SHOW')
        h.tick(0.1)
        h.tick(0.1)
        assert any('打开的是别的清单' in l for l in h.client.chat), h.client.chat
        h.g.OTHER_LIST = None
        # at the AH, not asked: still only offered; the quick menu entry adds it
        n = len(h.g.LISTS)
        h.client.chat.clear()
        h.type_in_channel('{{buy:菜单|14047×6}}')
        h.wait_chat('点它才加')
        assert len(h.g.LISTS) == n, 'not added without a confirmation, also at the AH'
        open_menu()
        entry = next(e for e in items(None) if e.text and '采购清单加进 Auctionator' in e.text.decode('utf-8'))
        assert entry.text.decode('utf-8') == '采购清单加进 Auctionator：菜单', entry.text
        entry.cb()
        h.tick(0.1)
        assert len(h.g.LISTS) == n + 1 and lists()[-1][1] == ['"Runecloth";;;;;;;;;;;;;6'] and h.g.LISTS[n + 1].ah is True, lists()
        # asked for in the question: added straight away (a name still loading is waited for); tab first, then the list
        h.g.LATE_ITEMS[7866] = 2
        h.client.chat.clear()
        h.type_in_channel('{{buy:|7866x1}} 帮我加进购物清单')
        line = h.wait_chat('已加进 Auctionator')
        assert '已在购物页打开并搜索' in line and '「」' not in line, line
        assert lists()[-1] == ('DSH 采购', ['"Empty Thaumaturgy Vessel";;;;;;;;;;;;;1']), lists()
        assert h.g.LISTS[len(h.g.LISTS)].clicks == h.g.CLICKS and h.g.LISTS[len(h.g.LISTS)].ah is True, 'tab clicked before the list'
        # asked for, but busy at the AH (confirming a purchase, or typing): nothing is clicked or created; /dshc buy does it
        for busy in ('BUYING', 'FOCUS'):
            setattr(h.g, busy, True)
            n, clicks = len(h.g.LISTS), h.g.CLICKS
            h.client.chat.clear()
            h.type_in_channel('{{buy:忙|14047×3}} 加进 Auctionator')
            line = h.wait_chat('没有打断你')
            assert len(h.g.LISTS) == n and h.g.CLICKS == clicks, f'busy ({busy}): no tab click, no list'
            assert '|Hitem:14047' in line and '×3' in line and '/dshc buy 打开' in line and '|Haddon:DSHChat:buy:' in line, line
            setattr(h.g, busy, None)
            h.g.SlashCmdList.DSHC(b'buy')
            h.tick(0.1)
            assert len(h.g.LISTS) == n + 1 and lists()[-1][1] == ['"Runecloth";;;;;;;;;;;;;3'], lists()
        # an old link still works while it is among the last 20; a forgotten one says so
        n = len(h.g.LISTS)
        click(1)
        h.tick(0.1)
        assert len(h.g.LISTS) == n + 1 and lists()[-1][1] == ['"Runecloth";;;;;;;;;;;;;14', '"Fine Thread";;;;;;;;;;;;;3'], lists()
        h.client.chat.clear()
        click(999)
        assert any('太旧' in l for l in h.client.chat), h.client.chat
        # no Auctionator: listed only, no link; /dshc buy says it cannot add; nothing parseable / unknown ids: says so
        h.lua.execute(b'SAVED_AUCTIONATOR = Auctionator Auctionator = nil')
        h.client.chat.clear()
        h.type_in_channel('{{buy:x|14047×1}}')
        line = h.wait_chat('没启用 Auctionator，只列出来')
        assert '|Hitem:14047' in line and '|Haddon:' not in line, line
        h.g.SlashCmdList.DSHC(b'buy')
        h.wait_chat('没启用 Auctionator，加不进去')
        h.lua.execute(b'Auctionator = SAVED_AUCTIONATOR')
        h.type_in_channel('{{buy:坏的|没有数字}}')
        h.wait_chat('格式不对')
        h.type_in_channel('{{buy:|888×1}}')
        h.wait_chat('里的物品 ID 游戏里都查不到')
        # what counts as asking for it
        asked = lambda q: h.ns.Core.AskedToAdd(q.encode('utf-8'))
        assert asked('帮我把材料加进购物清单') and asked('Add it to Auctionator') and asked('建个采购清单')
        assert not asked('列个采购清单') and not asked('裁缝现在做什么最赚钱') and not asked('加点说明')
        # parser details: last token wins, unclosed token stays text, duplicates merge, clamps, at most 12 items
        text, bodies = h.ns.Core.ExtractBuys('a{{buy:1|14047x1}}b{{buy:2|2321x2}}c{{buy:open'.encode('utf-8'))
        assert text.decode('utf-8') == 'abc{{buy:open' and [bytes(b).decode('utf-8') for b in bodies.values()] == ['1|14047x1', '2|2321x2'], (text, dict(bodies))
        spec = h.ns.Core.ParseBuy(('标题|' + ','.join(f'{1000 + i}×{i}' for i in range(1, 15)) + ',1001×5000').encode('utf-8'))
        items_ = [(it.id, it.qty) for it in spec[b'items'].values()]   # bytes keys (encoding=None); .items is a lupa method
        assert len(items_) == 12 and items_[0] == (1001, 1000) and items_[1] == (1002, 2), items_
        assert spec.title.decode('utf-8') == '标题'
        print('OK  shopping list: buy line hidden, offered with a link, added only on click / quick menu / /dshc buy / request, AH tab, busy AH, /reload, parser')

        # 11. map locations: Blizzard's own map-pin link; a pin only on click (Blizzard's handler) or when asked
        h.lua.execute('''
          MAPS = { [1429] = "Elwynn Forest", [1436] = "Westfall", [1411] = "Durotar", [1415] = "Eastern Kingdoms" }
          WAYPOINTS = {}
          C_Map.GetMapInfo = function(id) return MAPS[id] and { mapID = id, name = MAPS[id] } or nil end
          C_Map.CanSetUserWaypointOnMap = function(id) return id ~= 1415 end
          C_Map.SetUserWaypoint = function(p) p.btnRegistered = BTN_REG WAYPOINTS[#WAYPOINTS + 1] = p return true end
          UiMapPoint = { CreateFromCoordinates = function(m, x, y) return { uiMapID = m, x = x, y = y } end }
          function InCombatLockdown() return INCOMBAT == true end
          BTN_REG = true
          WorldMapFrame = { IsShown = function() return MAP_OPEN == true end, WorldMapTrackingPinButton = {
            IsEventRegistered = function(self, ev) return ev == "USER_WAYPOINT_UPDATED" and BTN_REG end,
            UnregisterEvent = function(self, ev) if ev == "USER_WAYPOINT_UPDATED" then BTN_REG = false end end,
            RegisterEvent = function(self, ev) if ev == "USER_WAYPOINT_UPDATED" then BTN_REG = true end end } }
          SPAWNS = {
            [448] = { [12] = { { 26.3, 91.1 } }, [40] = { { 30, 30 }, { 31, 31 } } },   -- one zone is the player's (Westfall)
            [240] = { [12] = { { 42.1, 65.9 } } },
            [777] = { [12] = { { 10, 10 } }, [14] = { { 20, 20 }, { 21, 21 } } },     -- most spawns: Durotar
            [500] = { [12] = { { -1, -1 } } },                                       -- instance spawn: no pin
          }
          NAMES = { [448] = "Hogger", [240] = "Marshal Dughan", [777] = "Somebody", [500] = "Boss" }
          NpcDB = { spawns = function(id) return SPAWNS[id] end, name = function(id) return NAMES[id] end }
          local zones = { [12] = 1429, [40] = 1436, [14] = 1411 }
          local ZoneDB = { GetUiMapIdByAreaId = function(self, a) return zones[a] end }
          QuestieLoader = { ImportModule = function(self, name) return name == "ZoneDB" and ZoneDB or { private = {} } end }'''.encode('utf-8'))
        render = h.ns.Core.RenderLine
        pin = '|A:Waypoint-MapPin-ChatIcon:13:13:0:0|a'
        elwynn = f'|cffffff00|Hworldmap:1429:4210:6590|h[{pin} Elwynn Forest 42.1, 65.9]|h|r'
        r = lambda s, found=None: render(s.encode('utf-8'), None, found).decode('utf-8')
        out = r('去找 {{loc:1429,42.1,65.9|治安官杜汉}} 交任务')
        assert out == f'去找 治安官杜汉 {elwynn} 交任务', out
        assert r('{{loc:1429,0.421,0.659|治安官杜汉}}') == f'治安官杜汉 {elwynn}', '0-1 fractions are scaled'
        assert r('{{loc:1429，42.1，65.9｜治安官杜汉}}') == f'治安官杜汉 {elwynn}', 'full-width comma and bar'
        assert r('{{loc:9999,42,65|没这张图}}') == '没这张图' and r('{{loc:1415,42,65|大陆}}') == '大陆', 'unknown / no-pin map -> name only'
        assert r('{{loc:1429,142,65|出界}}') == '出界' and r('{{loc:1429|没坐标}}') == '没坐标'
        assert r('{{foo:1|bar}}') == '{{foo:1||bar}}', 'a kind that is not ours stays as typed'
        # npc: QuestieDB spawns -> zone via Questie's ZoneDB; nearest spawn on the player's map (Westfall 52.1, 47.3)
        assert r('{{npc:448|霍格}}') == f'霍格（Hogger） |cffffff00|Hworldmap:1436:3100:3100|h[{pin} Westfall 31.0, 31.0]|h|r', r('{{npc:448|霍格}}')
        assert r('{{npc:240|治安官杜汉}}') == f'治安官杜汉（Marshal Dughan） {elwynn}', r('{{npc:240|治安官杜汉}}')
        assert r('{{npc:777|}}').endswith('|Hworldmap:1411:2000:2000|h[' + pin + ' Durotar 20.0, 20.0]|h|r'), 'zone with the most spawns'
        assert r('{{npc:777|}}').startswith('Somebody |c'), 'no label: the client name'
        assert r('{{npc:500|首领}}') == '首领（Boss）', 'instance spawn: no pin'
        assert r('{{npc:1|无名}}') == '无名'
        assert r('{{npc:240|Wanted Poster}}') == 'Wanted Poster（Marshal Dughan）', 'an English label that is another NPC: no pin'
        h.lua.execute(b'SAVED_QL = QuestieLoader QuestieLoader = nil')
        assert r('{{npc:240|治安官杜汉}}') == '治安官杜汉（Marshal Dughan）', 'no Questie zone table: name only'
        h.lua.execute(b'QuestieLoader = SAVED_QL')
        assert len(h.g.WAYPOINTS) == 0, 'rendering never sets a pin'
        # at most 8 location links per answer
        found = h.lua.table()
        out = r(' '.join(f'{{{{loc:1429,{10 + i},50|p{i}}}}}' for i in range(10)), found)
        assert out.count('|Hworldmap:') == 8 and len(found) == 8, (out.count('|Hworldmap:'), len(found))
        # through the bridge: not asked -> links only; asked -> the first location is pinned (not in combat / map open)
        h.client.chat.clear()
        h.type_in_channel('{{loc:1429,42.1,65.9|杜汉}} 在哪')
        line = h.wait_chat('回声测试')
        assert '|Hworldmap:1429:4210:6590|h' in line and len(h.g.WAYPOINTS) == 0, line
        h.client.chat.clear()
        h.type_in_channel('{{loc:1429,42.1,65.9|杜汉}} {{npc:777|某人}} 帮我标到地图')
        line = h.wait_chat('已放上地图标记')
        assert len(h.g.WAYPOINTS) == 1, 'the first location is pinned'
        wp = h.g.WAYPOINTS[1]
        assert wp.uiMapID == 1429 and abs(wp.x - 0.421) < 1e-9 and abs(wp.y - 0.659) < 1e-9, (wp.uiMapID, wp.x, wp.y)
        assert '杜汉，Elwynn Forest 42.1, 65.9' in line and '还有 1 个位置' in line, line
        assert wp.btnRegistered is False and h.g.BTN_REG is True, "the map's pin button is muted around the call, then listens again"
        # asked, but nothing pinnable: says so
        h.client.chat.clear()
        h.type_in_channel('{{loc:9999,1,1|哪里}} 标到地图')
        h.wait_chat('回答里没有能标到地图上的位置')
        # a late answer (after the 150 s timeout) still knows the question asked for a mark
        h.flush_voice = lambda: None
        h.client.spoken.clear()
        h.type_in_channel('{{loc:1429,42.1,65.9|迟到}} 帮我标到地图')
        h.tick(0.1)
        held = list(h.client.spoken)
        h.client.spoken.clear()
        h.client.clock += 151
        h.driver.scripts[b'OnUpdate'](h.driver, 0.05)
        del h.flush_voice
        for text in held:
            with open(r'\\.\pipe\%s' % PIPE, 'wb') as pp:
                pp.write(text.encode('utf-8'))
        h.type_in_channel('还在吗')               # the mailbox reads again while a question waits (as in game)
        line = h.wait_chat('已放上地图标记：迟到')
        assert len(h.g.WAYPOINTS) == 2, 'the late answer pinned it'
        h.g.INCOMBAT = True
        h.client.chat.clear()
        h.type_in_channel('{{loc:1429,42.1,65.9|杜汉}} 导航过去')
        h.wait_chat('战斗中不替你放地图标记')
        h.g.INCOMBAT = None
        h.g.MAP_OPEN = True
        h.type_in_channel('{{loc:1429,42.1,65.9|杜汉}} 标记一下')
        h.wait_chat('地图开着时不替你放标记')
        h.g.MAP_OPEN = None
        assert len(h.g.WAYPOINTS) == 2, 'no pin in combat or with the map open'
        mark = lambda q: h.ns.Core.AskedToMark(q.encode('utf-8'))
        assert mark('帮我标到地图') and mark('导航过去') and mark('标记一下') and mark('set a waypoint')
        assert not mark('目标是什么') and not mark('market price') and not mark('杜汉在哪')
        assert mark('把坐标标到地图上') and mark('带我去奥格的飞行点') and mark('mark it on the map')
        for q in ('不要标到地图，告诉我霍格在哪', '任务目标在哪', '霍格的坐标在哪', '任务目标到底在哪', '别导航，给我坐标就行',
                  'how do I remove my waypoint', '地图上的任务标记不显示了', '[Map Pin Location] 这附近有什么任务', '导航箭头是什么'):
            assert not mark(q), q
        print('OK  map locations: built-in map-pin links (loc + npc via QuestieDB), never pinned on render, pinned only when asked (not in combat / map open)')

        # 12. translation: the [DSH 翻译] chat type; the translation gets a [填入聊天框] link that fills the chat box in
        # the channel the player last really used (nothing is sent)
        h.lua.execute('''
          EB = { chatType = "DSHT", text = "" }
          function EB:GetChatType() return self.chatType end
          function EB:SetChatType(t) self.chatType = t end
          function EB:SetTellTarget(t) self.tell = t end
          function EB:SetChannelTarget(t) self.channel = t end
          function EB:UpdateHeader() self.header = true end
          function EB:SetText(t) self.text = t end
          ChatFrameUtil.GetActiveWindow = function() return EB end'''.encode('utf-8'))
        pre = h.g.CALLBACKS[b'ChatFrame.OnEditBoxPreSendText']
        whisper = h.lua.eval('''{ chatType = "WHISPER", text = "hi", tellTarget = "Bob",
          GetChatType = function(self) return self.chatType end, GetText = function(self) return self.text end,
          SetText = function(self, t) self.text = t end, GetAttribute = function(self, k) return self[k] end }''')
        pre[1](pre[2], whisper)
        assert whisper.text == b'hi', 'a real message is left alone'
        h.client.chat.clear()
        h.type_in_channel('你好，一起组队吗', b'DSHT')
        h.tick(0.1)
        assert any('[DSH 翻译] 原文：' in l and '你好，一起组队吗' in l for l in h.client.chat), h.client.chat
        line = h.wait_chat('[DSH 译文]')
        assert '译文测试：你好，一起组队吗' in line, line
        link = h.wait_chat('[填入聊天框]')
        assert '|Haddon:DSHChat:tr:1|h[填入聊天框]|h' in link, link
        assert not any('回声测试' in l for l in h.client.chat), 'a translation is not printed as an answer'
        link_cb = h.g.CALLBACKS[b'SetItemRef']
        link_cb[1](link_cb[2], b'addon:DSHChat:tr:1', b'[x]', b'LeftButton')
        eb = h.g.EB
        assert eb.text.decode('utf-8') == '译文测试：你好，一起组队吗', eb.text
        assert eb.chatType == b'WHISPER' and eb.tell == b'Bob' and eb.header is True, (eb.chatType, eb.tell)
        # the box already in a real channel keeps it
        eb.chatType = b'PARTY'
        link_cb[1](link_cb[2], b'addon:DSHChat:tr:1', b'[x]', b'LeftButton')
        assert eb.chatType == b'PARTY'
        link_cb[1](link_cb[2], b'addon:DSHChat:tr:99', b'[x]', b'LeftButton')
        h.wait_chat('这条译文太旧了')
        print('OK  translation: /dsht channel, translation printed with [填入聊天框], fills the last real channel, sends nothing')
    except AssertionError as e:
        ok = False
        print('FAIL', e)
    finally:
        out = h.close()
        print('--- bridge log ---')
        print(out)
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
