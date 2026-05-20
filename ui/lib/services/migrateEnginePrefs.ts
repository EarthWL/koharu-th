import { api } from '@/lib/api'

/// One-time migration: before the Engines-tab consolidation, the detector
/// and OCR engine were chosen on the Settings page (preferencesStore). That
/// choice now lives in the machine-wide engine profile. A user upgrading
/// from a build that selected `anime_yolo` / Manga OCR would silently revert
/// to the defaults (comic_text_detector / MIT-48px) unless we seed the
/// profile from their old localStorage prefs.
///
/// Idempotent + guarded: runs once (localStorage flag), only seeds when the
/// legacy choice was non-default AND the profile has no override yet. Any
/// failure is swallowed — worst case the user re-picks in the Engines tab.

const MIGRATED_FLAG = 'koharu-engine-prefs-migrated-v1'
/// zustand persist `name` for preferencesStore (see preferencesStore.ts).
const CONFIG_KEY = 'koharu-config'

// Engine ids — mirror the `ENGINE_ID` consts in koharu-pipeline/src/engines.
const ANIME_YOLO_DETECTOR = 'anime_yolo_detector'
const MANGA_OCR = 'manga_ocr'

export async function migrateLegacyEnginePrefs(): Promise<void> {
  try {
    if (typeof window === 'undefined') return
    if (localStorage.getItem(MIGRATED_FLAG)) return

    const raw = localStorage.getItem(CONFIG_KEY)
    const legacy: Record<string, unknown> = raw
      ? ((JSON.parse(raw)?.state ?? {}) as Record<string, unknown>)
      : {}

    const wantsAnimeYolo = legacy.detectorEngine === 'anime_yolo'
    const wantsMangaOcr = legacy.ocrEngine === 'manga'

    // Nothing non-default to carry over → mark done so we never re-read.
    if (!wantsAnimeYolo && !wantsMangaOcr) {
      localStorage.setItem(MIGRATED_FLAG, '1')
      return
    }

    const profile = await api.engineProfileGet()
    const active = profile.active ?? {}

    if (wantsAnimeYolo && !active['detection_boxes']) {
      // anime_yolo produces both detection + its bundled segmentation.
      await api.engineProfileSetActive('detection_boxes', ANIME_YOLO_DETECTOR)
      await api.engineProfileSetActive('segmentation_mask', ANIME_YOLO_DETECTOR)
      if (typeof legacy.animeYoloVariant === 'string') {
        await api.engineProfileSetSetting(
          ANIME_YOLO_DETECTOR,
          'variant',
          legacy.animeYoloVariant,
        )
      }
      if (typeof legacy.animeYoloConfidence === 'number') {
        await api.engineProfileSetSetting(
          ANIME_YOLO_DETECTOR,
          'confidence_threshold',
          legacy.animeYoloConfidence,
        )
      }
    }

    if (wantsMangaOcr && !active['ocr_text']) {
      await api.engineProfileSetActive('ocr_text', MANGA_OCR)
    }

    localStorage.setItem(MIGRATED_FLAG, '1')
  } catch (err) {
    // Resources may not be ready yet, or the legacy blob is malformed —
    // don't set the flag so a later launch can retry. Never throws.
    console.warn('[migrate-engine-prefs] skipped:', err)
  }
}
