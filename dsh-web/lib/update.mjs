// Updates from GitHub. DSH updates a Git-installed bundle only to a spec pinning a full commit of the same repository
// directory (dsh-plugin-manager updateBundle: `git+https://github.com/<owner>/<repo>.git#<sha>&path:/<dir>`), and has
// no version list for Git bundles, so this module finds the newest commit on the default branch and the package
// version at that commit. No DSH imports; network errors become { error }.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
const UA = 'dsh-wow-bridge-update-check';

export function packageInfo(file = PKG_FILE) {
  try {
    const p = JSON.parse(fs.readFileSync(file, 'utf8'));
    const url = typeof p.repository === 'string' ? p.repository : p.repository?.url;
    const m = /github\.com[/:]([^/]+)\/([^/#.]+)(?:\.git)?/i.exec(String(url ?? ''));
    return {
      name: p.name, version: p.version,
      repo: m ? { owner: m[1], name: m[2], dir: String(p.repository?.directory ?? '').replace(/^\/+|\/+$/g, ''), branch: 'main' } : null,
    };
  } catch { return { name: undefined, version: undefined, repo: null }; }
}

// a > b for plain x.y.z versions (pre-release tags: a release beats its pre-releases)
export function newer(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(String(v ?? '').trim());
    return m ? [+m[1], +m[2], +m[3], m[4] ?? null] : null;
  };
  const x = parse(a), y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  if (x[3] === y[3]) return false;
  if (x[3] === null) return true;
  if (y[3] === null) return false;
  return x[3] > y[3];
}

export const gitSpec = (repo, sha) =>
  `git+https://github.com/${repo.owner}/${repo.name}.git#${sha}${repo.dir ? `&path:/${repo.dir}` : ''}`;

// { current, latest, sha, newer, spec, checkedAt } or { error }
export async function checkUpdate({ info = packageInfo(), fetchImpl = globalThis.fetch, signal } = {}) {
  const checkedAt = new Date().toISOString();
  if (!info.repo) return { error: 'package.json 里没有 GitHub 仓库地址', checkedAt };
  const { owner, name, dir, branch } = info.repo;
  const get = async (url, accept) => {
    const r = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: accept }, signal: signal ?? AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`${new URL(url).host} 回答 ${r.status}`);
    return r;
  };
  try {
    const commit = await (await get(`https://api.github.com/repos/${owner}/${name}/commits/${branch}`, 'application/vnd.github+json')).json();
    const sha = String(commit?.sha ?? '');
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('GitHub 没给出最新提交');
    const pkg = await (await get(`https://raw.githubusercontent.com/${owner}/${name}/${sha}/${dir ? `${dir}/` : ''}package.json`, 'application/json')).json();
    const latest = String(pkg?.version ?? '');
    return { current: info.version, latest, sha, newer: newer(latest, info.version), spec: gitSpec(info.repo, sha), checkedAt };
  } catch (e) { return { error: String(e?.message ?? e), checkedAt }; }
}
