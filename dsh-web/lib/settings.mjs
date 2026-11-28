// The player's server and faction, set on the plugin's settings page (stored in %APPDATA%\DSHBridge\config.json with
// the game folder). They decide where prices come from:
//   EU / US Forever -> wowauctions.net (our wow_item_market / wow_craft_profit tools, by ruleset and faction)
//   China (国服)     -> 无限图鉴 (wuxianwow MCP auction_house, house = <ruleset>-<faction>)
// Read by index.js, wowf-market-tools.js, wowf-tool-policy.js and answer.mjs prompt(). No DSH imports.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// %APPDATA%\DSHBridge (DSHB_DATA_DIR overrides it, for tests); read on every call
export const defaultDataDir = () => process.env.DSHB_DATA_DIR
  || path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'DSHBridge');
export const CONFIG_FILE = 'config.json';

// key -> region, ruleset (as the price source names it), label
export const SERVERS = {
  'eu-pvp': { region: 'eu', ruleset: 'pvp', label: '欧服 PvP' },
  'eu-pve': { region: 'eu', ruleset: 'pve', label: '欧服 PvE' },
  'eu-rp': { region: 'eu', ruleset: 'rp', label: '欧服 RP' },
  'eu-rp-pvp': { region: 'eu', ruleset: 'rp-pvp', label: '欧服 RP-PvP' },
  'us-pvp': { region: 'us', ruleset: 'pvp', label: '美服 PvP' },
  'us-pve': { region: 'us', ruleset: 'pve', label: '美服 PvE' },
  'us-rp': { region: 'us', ruleset: 'rp', label: '美服 RP' },
  'us-rp-pvp': { region: 'us', ruleset: 'rp-pvp', label: '美服 RP-PvP' },
  'cn-pvp': { region: 'cn', ruleset: 'pvp', label: '国服 PvP' },
  'cn-normal': { region: 'cn', ruleset: 'normal', label: '国服 普通' },
  'cn-rp': { region: 'cn', ruleset: 'rp', label: '国服 角色扮演' },
};
export const DEFAULT_SERVER = 'eu-pvp';
export const FACTIONS = ['auto', 'Horde', 'Alliance'];   // auto = the character's own faction (sent by the addon)

export const serverKey = (k) => (Object.hasOwn(SERVERS, String(k)) ? String(k) : DEFAULT_SERVER);
export const factionSetting = (f) => (FACTIONS.includes(f) ? f : 'auto');
export const factionZh = (f) => (f === 'Alliance' ? '联盟' : '部落');

// The faction to use: the setting, or the character's (ctxFaction), or Horde.
export function factionFor(settings, ctxFaction) {
  const s = factionSetting(settings?.faction);
  if (s !== 'auto') return s;
  return ctxFaction === 'Alliance' ? 'Alliance' : 'Horde';
}

// Everything the prompt and the tools need about one server + faction.
export function serverInfo(settings, ctxFaction) {
  const key = serverKey(settings?.server);
  const s = SERVERS[key];
  const faction = factionFor(settings, ctxFaction);
  const prices = s.region === 'cn' ? 'wuxianwow' : 'wowauctions';
  return {
    key, ...s, faction, prices,
    realm: prices === 'wowauctions' ? `forever-${s.region}/${s.ruleset}-forever-${s.region}` : undefined,
    house: prices === 'wuxianwow' ? `${s.ruleset}-${faction === 'Alliance' ? 'alliance' : 'horde'}` : undefined,
  };
}

// config.json, re-read when it changes (mtime), never throws.
let cache = { file: '', mtime: -1, value: {} };
export const forgetConfigCache = () => { cache = { file: '', mtime: -1, value: {} }; };
export function readLocalConfig(dataDir = defaultDataDir()) {
  const file = path.join(dataDir, CONFIG_FILE);
  try {
    const mtime = fs.statSync(file).mtimeMs;
    if (cache.file === file && cache.mtime === mtime) return cache.value;
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const value = j && typeof j === 'object' && !Array.isArray(j) ? j : {};
    cache = { file, mtime, value };
    return value;
  } catch { return {}; }
}

export const readSettings = (dataDir = defaultDataDir()) => {
  const c = readLocalConfig(dataDir);
  return { server: serverKey(c.server), faction: factionSetting(c.faction) };
};

// wowauctions realm, label and faction for our market tools. The faction the model passes wins, else the setting
// (auto = Horde here: the prompt names the character's faction and the model passes it). China: refused, its prices
// are 无限图鉴's auction_house.
export function marketTarget(argFaction, settings = readSettings()) {
  const s = serverInfo(settings);
  if (s.prices !== 'wowauctions') throw new Error(`设置里的服务器是${s.label}：价格请用 mcp__wuxianwow__auction_house（house: ${s.house}）。`);
  const f = String(argFaction ?? '').trim();
  const faction = f ? (/^(alliance|联盟)$/i.test(f) ? 'alliance' : 'horde') : (s.faction === 'Alliance' ? 'alliance' : 'horde');
  return { realm: s.realm, server: s.label, faction, region: s.region, ruleset: s.ruleset };
}
