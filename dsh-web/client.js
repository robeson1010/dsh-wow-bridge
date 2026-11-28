// Browser half of @local/dsh-wow-bridge: the plugin's settings page, as its own entry in DSH's Settings (slot
// `settings.section`, beside General / Models / Plugins) and on the bundle's page under Plugins (`plugins.bundle.config`). Hand-written in the client module system's lazy-CJS factory format (no build step):
// React and the primitives come from the platform module table. Everything it changes goes through the Host plugin's
// exact routes /api/wow-dsh-bridge/* (index.js), which write %APPDATA%\DSHBridge\config.json and do the installs.
window.__ModuleLoader__.load({ id: '@local/dsh-wow-bridge', factory: (require) => {
  var module = { exports: {} };
  var exports = module.exports;
  Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

  const React = require('react');
  const h = React.createElement;
  const { useState, useEffect, useCallback, useRef } = React;
  let P = {};
  try { P = require('@deepseek-ai/dsh-client-ui-primitives') || {}; } catch { P = {}; }

  const PKG = '@local/dsh-wow-bridge';

  async function call(name, body) {
    const url = new URL(`api/wow-dsh-bridge/${name}`, document.baseURI);
    const init = body === undefined
      ? { method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' } }
      : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) };
    const carrier = globalThis.__DSH_TRANSPORT__ && globalThis.__DSH_TRANSPORT__.fetch;
    const res = carrier ? await carrier(url.href, init) : await fetch(url, init);
    let j = null;
    try { j = await res.json(); } catch { j = null; }
    if (!res.ok) throw new Error((j && j.error) || `HTTP ${res.status}`);
    return j;
  }

  // ---- small pieces (the primitives' Button when present, else a plain button) ----
  const css = {
    page: { display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '720px', fontSize: '14px', lineHeight: 1.6 },
    section: { display: 'flex', flexDirection: 'column', gap: '8px', paddingBottom: '16px', borderBottom: '1px solid rgba(127,127,127,0.2)' },
    title: { fontSize: '15px', fontWeight: 600, margin: 0 },
    row: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' },
    muted: { opacity: 0.7, fontSize: '13px' },
    ok: { color: '#2e9d5b' },
    warn: { color: '#c77d00' },
    err: { color: '#d64545' },
    code: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: '12px', wordBreak: 'break-all' },
    input: { flex: '1 1 280px', minWidth: 0, padding: '5px 8px', borderRadius: '6px', border: '1px solid rgba(127,127,127,0.4)', background: 'transparent', color: 'inherit', font: 'inherit' },
    select: { padding: '5px 8px', borderRadius: '6px', border: '1px solid rgba(127,127,127,0.4)', background: 'transparent', color: 'inherit', font: 'inherit' },
    pre: { margin: 0, padding: '8px', borderRadius: '6px', background: 'rgba(127,127,127,0.1)', whiteSpace: 'pre-wrap', maxHeight: '160px', overflow: 'auto', fontSize: '12px' },
  };
  function Btn({ onClick, disabled, primary, children }) {
    if (typeof P.Button === 'function') {
      return h(P.Button, { variant: primary ? 'primary' : 'outline', size: 'sm', onClick, disabled }, children);
    }
    return h('button', { type: 'button', onClick, disabled, style: { padding: '4px 12px', borderRadius: '6px', cursor: disabled ? 'default' : 'pointer' } }, children);
  }
  const Section = ({ title, children }) => h('section', { style: css.section }, h('h3', { style: css.title }, title), children);
  const Line = ({ style, children }) => h('div', { style: { ...css.row, ...style } }, children);

  function Page(props) {
    const [st, setSt] = useState(null);
    const [err, setErr] = useState('');
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState('');
    const [dir, setDir] = useState('');
    const [output, setOutput] = useState('');
    const alive = useRef(true);
    useEffect(() => () => { alive.current = false; }, []);

    const load = useCallback(async () => {
      try {
        const s = await call('status');
        if (!alive.current) return;
        setSt(s); setErr('');
      } catch (e) { if (alive.current) setErr(`读不到插件状态：${e.message}（插件没启用，或 dsh web 需要重启）`); }
    }, []);
    useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);
    // a fresh update check when the page opens (the host checks every 6 hours on its own)
    const checked = useRef(false);
    useEffect(() => {
      if (!st || checked.current) return;
      checked.current = true;
      const at = st.update && st.update.checkedAt ? Date.parse(st.update.checkedAt) : 0;
      if (!(Date.now() - at < 10 * 60 * 1000)) call('update-check', {}).then((r) => { if (alive.current && r && r.plugin) setSt(r); }).catch(() => {});
    }, [st]);   // eslint-disable-line
    useEffect(() => { if (st && !dir) setDir(st.settings.wowDir || st.game.addons || ''); }, [st]);   // eslint-disable-line

    const run = async (what, name, body, done) => {
      setBusy(what); setErr(''); setNote('');
      try {
        const r = await call(name, body);
        if (!alive.current) return;
        if (r && r.plugin) setSt(r); else if (r && r.status) setSt(r.status);
        if (done) done(r);
      } catch (e) { if (alive.current) setErr(e.message); } finally { if (alive.current) setBusy(''); }
    };

    if (props && props.view === 'summary') return h('span', null, '游戏内 [DSH] 频道：服务器、游戏目录、游戏插件、静音语音、买卖行情定时报告、自动升级');
    if (!st) return h('div', { style: css.page }, err ? h('div', { style: css.err }, err) : h('div', { style: css.muted }, '读取中…'));

    const s = st.settings;
    const cn = String(s.server).startsWith('cn-');
    const factionLabel = { auto: '按角色自动', Horde: '部落', Alliance: '联盟' };

    // 1. server and faction
    const server = h(Section, { title: '服务器和阵营' },
      h(Line, null,
        h('label', null, '服务器 '),
        h('select', { style: css.select, value: s.server, disabled: !!busy, onChange: (e) => run('server', 'settings', { server: e.target.value }, () => setNote('已保存：各角色下一个问题会开新对话。')) },
          st.servers.map((x) => h('option', { key: x.key, value: x.key }, x.label))),
        h('label', { style: { marginLeft: '12px' } }, '阵营 '),
        h('select', { style: css.select, value: s.faction, disabled: !!busy, onChange: (e) => run('faction', 'settings', { faction: e.target.value }, () => setNote('已保存：各角色下一个问题会开新对话。')) },
          ['auto', 'Horde', 'Alliance'].map((f) => h('option', { key: f, value: f }, factionLabel[f])))),
      h('div', { style: css.muted }, cn
        ? '价格和商机：无限图鉴的拍卖行数据（游戏内采集，每天更新），按规则集和阵营选拍卖行。'
        : '价格和商机：wowauctions.net 和 Forever AH（都是大约每小时一份快照），按规则集和阵营选拍卖行。'),
      h('div', { style: css.muted }, '“按角色自动”用游戏里当前角色的阵营。'));

    // 1b. where the game conversations go in dsh web
    const wsList = st.workspaces || [];
    const chats = h(Section, { title: '游戏对话放在哪里' },
      h(Line, null,
        h('label', null, '工作区 '),
        h('select', { style: css.select, value: s.workspaceId || '', disabled: !!busy,
          onChange: (e) => run('ws', 'settings', { workspaceId: e.target.value }, () => setNote('已保存：各角色下一个问题会在这里开新对话。')) },
          h('option', { value: '' }, '不放进工作区'),
          wsList.map((w) => h('option', { key: w.id, value: w.id }, `${w.title}（${w.path}）`)))),
      h('div', { style: css.muted }, '游戏里的提问在 dsh web 里是一个个对话（“魔兽 · 角色名”）。选一个已有的工作区，它们就排在那个工作区下面；插件不会自己建工作区。'));

    // 2. game folder
    const g = st.game;
    const via = { config: '你设置的', 'battle.net': 'Battle.net 安装记录', common: '常见安装位置' }[g.via] || '';
    const folder = h(Section, { title: '游戏目录' },
      g.addons
        ? h('div', null, h('span', { style: css.ok }, '✓ '), h('span', { style: css.code }, g.addons), h('span', { style: css.muted }, `（${via}）`))
        : h('div', { style: css.warn }, g.notFound || '还没有游戏目录'),
      h(Line, null,
        h('input', { style: css.input, value: dir, placeholder: '例如 D:\\Program Files\\World of Warcraft', onChange: (e) => setDir(e.target.value) }),
        h(Btn, { disabled: !!busy || !dir.trim(), onClick: () => run('dir', 'settings', { wowDir: dir.trim() }, () => setNote('游戏目录已保存。')) }, '使用这个目录'),
        h(Btn, { disabled: !!busy, onClick: () => run('pick', 'pick-folder', {}, (r) => { if (r && r.picked) { setDir(r.picked); setNote('游戏目录已保存。'); } else setNote('没有选择文件夹。'); }) }, busy === 'pick' ? '请在电脑上的窗口里选择…' : '选择文件夹…'),
        s.wowDir ? h(Btn, { disabled: !!busy, onClick: () => run('auto', 'settings', { wowDir: '' }, () => { setDir(''); setNote('改为自动查找。'); }) }, '改回自动查找') : null),
      h('div', { style: css.muted }, '选 World of Warcraft 文件夹或里面的 _forever_ 都可以。选择窗口会出现在这台电脑的桌面上（可能在浏览器后面）。'),
      g.detected && g.detected !== g.addons ? h('div', { style: css.muted }, `自动找到的：${g.detected}`) : null);

    // 3. the addon
    const a = st.addon;
    const addonState = !g.addons ? null
      : !a.installed ? h('span', { style: css.warn }, '还没安装')
      : a.complete && !a.changed.length ? h('span', { style: css.ok }, `✓ 已安装 ${a.installed}（最新）`)
      : h('span', { style: css.warn }, `已安装 ${a.installed}，有更新${a.missing.length ? `：缺 ${a.missing.length} 个文件` : ''}${a.slots < 1024 ? '，回信槽位不全' : ''}`);
    const addon = h(Section, { title: `游戏插件 DSHChat ${a.shipped}` },
      addonState ? h('div', null, addonState) : h('div', { style: css.muted }, '先设置游戏目录。'),
      a.waiting ? h('div', { style: css.warn }, '游戏开着，新文件装不进去：退出游戏后会自动装好，下次开游戏就能用。') : null,
      h(Line, null,
        h(Btn, { primary: !a.installed, disabled: !!busy || !g.addons, onClick: () => run('addon', 'install-addon', {}, (r) => setNote(r.gameRunning
          ? '已更新现有文件（游戏里 /reload 生效）；新文件等退出游戏后自动装。' : '已安装：开游戏后在角色选择界面的插件列表里确认 DSH 频道已启用。')) },
        a.installed ? '更新游戏插件' : '安装游戏插件')),
      h('div', { style: css.muted }, g.running ? '游戏正在运行。' : '游戏没在运行。'),
      h('div', { style: css.muted }, '装好以后，插件每次启动和升级后都会把游戏插件同步到最新。'));

    // 4. the silent voice
    const v = st.voice;
    const voice = h(Section, { title: '静音语音（游戏 → 电脑）' },
      h('div', null, v.installed ? h('span', { style: css.ok }, '✓ 已安装') : h('span', { style: css.warn }, `还没安装${v.dll || v.userClass || v.machineToken ? '完整' : ''}`)),
      h(Line, null,
        h(Btn, { primary: !v.installed, disabled: !!busy || v.busy, onClick: () => run('voice', 'install-voice', {}, (r) => {
          setOutput(r.result && r.result.output || '');
          setNote(r.result && r.result.ok ? '静音语音已安装：请完整退出游戏再打开（/reload 不够）。' : '安装没有完成，看下面的输出。');
        }) }, busy === 'voice' ? '安装中…（请在弹出的“用户账户控制”窗口点“是”）' : v.installed ? '重新安装' : '安装静音语音')),
      h('div', { style: css.muted }, '游戏用一个音量为 0 的 Windows 语音把问题传给这台电脑。安装时用 Windows 自带的编译器编译，并弹一次“用户账户控制”（只写入语音名片）。'),
      output ? h('pre', { style: css.pre }, output) : null);

    // 4b. the buy/sell report every N hours (a DSH scheduled task)
    const mk = st.market || {};
    const when = (iso) => { try { return iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : ''; } catch { return ''; } };
    const market = h(Section, { title: '买卖行情定时报告（DSH 自动化任务）' },
      !mk.available ? h('div', { style: css.warn }, '这个 DSH 没有自动化任务（Schedule）服务，用不了定时报告；游戏里问“行情”仍然可以。')
      : !mk.supported ? h('div', { style: css.muted }, '只有欧服、美服有这项功能（数据来自 Forever AH）。')
      : h(Line, null,
        h('label', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
          h('input', { type: 'checkbox', checked: !!mk.on, disabled: !!busy, onChange: (e) => { const on = e.target.checked; run('market', 'settings', { marketReport: on },
            () => setNote(on ? `已打开：DSH 的“自动化任务”里多了一个“${mk.title || '魔兽买卖行情（定时）'}”。` : '已关闭，定时任务已删除。')); } }),
          '自动看“现在什么值得买、什么值得卖”，每隔'),
        h('select', { style: css.select, value: String(mk.hours || 2), disabled: !!busy, onChange: (e) => { const n = Number(e.target.value); run('market-hours', 'settings', { marketHours: n },
          () => setNote(`已保存：每 ${n} 小时一次。`)); } },
          (mk.choices || [1, 2, 3, 4, 6, 8, 12, 24]).map((n) => h('option', { key: n, value: String(n) }, `${n} 小时`))),
        h('span', null, '一次'),
        mk.on && mk.id ? h(Btn, { disabled: !!busy, onClick: () => run('market-run', 'market-run', {}, () => setNote('已开始运行：一会儿在 DSH 的对话“魔兽 · #买卖行情（定时）”里看结果。')) }, busy === 'market-run' ? '正在启动…' : '现在运行一次') : null),
      mk.on && mk.id ? h('div', null, mk.status === 'paused' ? h('span', { style: css.warn }, '任务在 DSH 里被暂停了。') : `下次运行：${when(mk.next) || '—'}`, mk.last ? `；上次运行：${when(mk.last)}` : '；还没运行过') : null,
      mk.on && mk.taskEverySeconds ? h('div', { style: css.warn }, `这个任务在 DSH 里被改成了每 ${Math.round(mk.taskEverySeconds / 360) / 10} 小时一次；在上面重新选一次间隔就按这里的来。`) : null,
      mk.on && mk.missing ? h('div', { style: css.warn }, '定时任务在 DSH 里找不到了：把开关关掉再打开。') : null,
      mk.error ? h('div', { style: css.err }, mk.error) : null,
      h('div', { style: css.muted }, '用的是 DSH 自带的自动化任务：到时间 DSH 让 AI 查一次那份大交易量常见物品清单，把现在最值得买的、最值得卖的和价格写在对话“魔兽 · #买卖行情（定时）”里（写满一定次数会自动换一个新对话）。价格要你在拍卖行核实，买卖自己点。'),
      h('div', { style: css.muted }, '拍卖行数据每小时才更新一次，所以最短 1 小时。每次运行用一次 AI 回答的额度；dsh web 没开着就不跑，下次启动时只补最近错过的一次。也可以在 DSH 的“自动化任务”页面里暂停它；在那里删掉任务等于关掉这个开关。'));

    // 5. updates
    const u = st.update || {};
    const restartNow = () => run('restart', 'restart', {}, () => setNote('dsh web 正在重启：几秒后刷新这一页。重启后它在后台运行（不在原来的终端窗口里）。'));
    const updates = h(Section, { title: '升级' },
      u.restarted ? h('div', { style: css.ok }, `✓ ${u.restarted}`) : null,
      h('div', null, `当前版本 ${u.current || st.plugin.version}`,
        u.needsRestart ? h('span', { style: css.warn }, `，${u.needsRestart} 已装好，重启 dsh web 后生效`)
        : u.latest ? (u.newer ? h('span', { style: css.warn }, `，GitHub 上有新版本 ${u.latest}`) : h('span', { style: css.ok }, '，已是最新'))
        : null,
        u.error ? h('span', { style: css.err }, `（检查失败：${u.error}）`) : null),
      u.message ? h('div', null, u.message) : null,
      h(Line, null,
        h(Btn, { disabled: !!busy || u.checking, onClick: () => run('check', 'update-check', {}) }, u.checking ? '检查中…' : '检查更新'),
        u.newer && !u.needsRestart ? h(Btn, { primary: true, disabled: !!busy || u.applying, onClick: () => run('update', 'update', {}, (r) => {
          if (r.error) setErr(r.error + (r.spec ? `\n${r.spec}` : ''));
          else setNote(`正在升级到 ${r.to}：装好后会自动重启 dsh web，之后刷新这一页。`);
        }) }, u.applying ? '升级中…' : `升级到 ${u.latest}`) : null,
        u.needsRestart && !u.desktop ? h(Btn, { primary: true, disabled: !!busy, onClick: restartNow }, busy === 'restart' ? '正在重启…' : '重启 dsh web') : null,
        h('label', { style: { display: 'flex', alignItems: 'center', gap: '6px', marginLeft: '8px' } },
          h('input', { type: 'checkbox', checked: !!s.autoUpdate, disabled: !!busy, onChange: (e) => run('auto-update', 'settings', { autoUpdate: e.target.checked }) }),
          '有新版本时自动下载安装')),
      h('div', { style: css.muted }, u.desktop
        ? 'DSH 桌面版：插件装好后由桌面版重启。'
        : '自动下载安装不会打断你：装好后在这里点“重启 dsh web”生效；手动点“升级”会装好后自动重启。'),
      st.plugin.repo ? h('div', { style: css.muted }, `来源：github.com/${st.plugin.repo}（dsh web 每 6 小时检查一次，打开这一页时也会检查）`) : null);

    return h('div', { style: css.page },
      err ? h('div', { style: { ...css.err, whiteSpace: 'pre-wrap' } }, err) : null,
      note ? h('div', { style: css.ok }, note) : null,
      server, chats, folder, addon, voice, market, updates);
  }

  exports.inject = ['slots'];
  exports.apply = function apply(ctx) {
    // its own entry in Settings (like General / Models / Plugins)
    ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section', id: 'wow-dsh-bridge', order: 2, label: () => '魔兽世界',
    }, Page)), 'wow-dsh-bridge: settings section');
    // and on the bundle's page under Plugins
    ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
      name: 'plugins.bundle.config', key: PKG,
    }, Page)), 'wow-dsh-bridge: plugin page');
  };
  return module.exports;
} });
