/** Pure, dependency-free version helpers (SemVer 2.0 precedence). */

/** True for pre-release builds such as `1.0.4-beta.1` / `1.0.5-alpha`. */
export function isPrerelease(version: string): boolean {
  return String(version).trim().includes('-')
}

function splitVersion(v: string): { core: number[]; pre: string[] } {
  const s = String(v).trim().replace(/^v/i, '').split('+')[0]!
  const dash = s.indexOf('-')
  const coreStr = dash === -1 ? s : s.slice(0, dash)
  const preStr = dash === -1 ? '' : s.slice(dash + 1)
  return {
    core: coreStr.split('.').map((x) => parseInt(x, 10) || 0),
    pre: preStr ? preStr.split('.') : []
  }
}

/** SemVer 2.0 precedence: <0 when a < b, 0 when equal, >0 when a > b. */
export function compareVersions(a: string, b: string): number {
  const x = splitVersion(a)
  const y = splitVersion(b)
  const len = Math.max(x.core.length, y.core.length)
  for (let i = 0; i < len; i++) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0)
    if (d !== 0) return d
  }
  // Same core: a release outranks any of its pre-releases (1.0.4 > 1.0.4-beta.1).
  if (x.pre.length === 0 || y.pre.length === 0) return y.pre.length - x.pre.length
  const n = Math.max(x.pre.length, y.pre.length)
  for (let i = 0; i < n; i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    const pn = /^\d+$/.test(p)
    const qn = /^\d+$/.test(q)
    if (pn && qn) {
      const d = parseInt(p, 10) - parseInt(q, 10)
      if (d !== 0) return d
    } else if (pn !== qn) {
      return pn ? -1 : 1 // numeric identifiers sort before alphanumeric ones
    } else if (p !== q) {
      return p < q ? -1 : 1 // 'alpha' < 'beta' < 'rc'
    }
  }
  return 0
}

/** True when `latest` is strictly newer than `installed` (SemVer, pre-release aware). */
export function isNewerVersion(latest: string, installed: string): boolean {
  return compareVersions(latest, installed) > 0
}
