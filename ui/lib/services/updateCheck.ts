/**
 * Lightweight "is there a newer release?" check via the GitHub Releases
 * API. No code signing or Tauri-updater plugin required — we just hit
 * api.github.com, compare semver, and return a hint the UI can render
 * as a notification with a link to the release page.
 *
 * Public API (no auth needed): rate-limited to 60 requests/hour per IP,
 * which is fine for a "user clicks Check for updates" flow.
 */

const REPO = 'EarthWL/koharu-th'
const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`

export type UpdateCheckResult =
  | {
      kind: 'up-to-date'
      currentVersion: string
      latestVersion: string
    }
  | {
      kind: 'update-available'
      currentVersion: string
      latestVersion: string
      releaseUrl: string
      publishedAt: string | null
      body: string | null
    }
  | {
      kind: 'error'
      message: string
    }

/**
 * Compare two `MAJOR.MINOR.PATCH[-prerelease]` strings. Returns:
 *   <0 if a < b
 *   =0 if a == b
 *   >0 if a > b
 *
 * Handles the leading `v` GitHub tags carry. Ignores prerelease suffix
 * for the headline comparison — we just want "is there something
 * newer than what I'm running".
 */
export function compareSemver(a: string, b: string): number {
  const norm = (s: string) =>
    s
      .trim()
      .replace(/^v/i, '')
      .split('-')[0]
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0)
  const [aMaj, aMin, aPat] = norm(a)
  const [bMaj, bMin, bPat] = norm(b)
  return aMaj - bMaj || aMin - bMin || aPat - bPat
}

/**
 * Fetch the latest published (non-draft, non-prerelease) release and
 * compare against `currentVersion`. Throws never — wraps any error in
 * an `{ kind: 'error', message }` result so callers can render it.
 */
export async function checkForUpdates(
  currentVersion: string,
): Promise<UpdateCheckResult> {
  try {
    const res = await fetch(LATEST_URL, {
      headers: { Accept: 'application/vnd.github+json' },
    })
    if (!res.ok) {
      return {
        kind: 'error',
        message: `GitHub API returned ${res.status}: ${await res
          .text()
          .catch(() => res.statusText)}`,
      }
    }
    const payload = (await res.json()) as {
      tag_name?: string
      name?: string
      html_url?: string
      published_at?: string
      body?: string
    }
    const latest = payload.tag_name ?? payload.name ?? ''
    if (!latest) {
      return { kind: 'error', message: 'No tag_name on latest release' }
    }
    if (compareSemver(latest, currentVersion) <= 0) {
      return {
        kind: 'up-to-date',
        currentVersion,
        latestVersion: latest,
      }
    }
    return {
      kind: 'update-available',
      currentVersion,
      latestVersion: latest,
      releaseUrl:
        payload.html_url ?? `https://github.com/${REPO}/releases/latest`,
      publishedAt: payload.published_at ?? null,
      body: payload.body ?? null,
    }
  } catch (err: any) {
    return { kind: 'error', message: err?.message ?? String(err) }
  }
}
