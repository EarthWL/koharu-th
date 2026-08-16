import { expect, test } from './helpers/test'
import {
  PIPELINE_SINGLE,
  bootstrapApp,
  getWorkspaceViewport,
  importAndOpenPage,
} from './helpers/app'
import {
  clampZoom,
  ctrlWheelZoomStep,
  dragZoomSliderTo,
  readZoomPercent,
} from './helpers/canvas'

test.beforeEach(async ({ page }) => {
  await bootstrapApp(page)
})

test('ctrl+wheel zoom is monotonic and slider stays clamped', async ({ page }) => {
  await importAndOpenPage(page, PIPELINE_SINGLE)
  const viewport = await getWorkspaceViewport(page)

  // Use deltaY = 10 so that step = max(1, 10 * ZOOM_SENSITIVITY(0.1)) = 1%
  // per wheel event — matches the loop's expected ±1 per tick.
  const zoomOutDelta = 10
  const zoomInDelta = -10

  let currentZoom = await readZoomPercent(page)
  for (let i = 0; i < 4; i += 1) {
    const expected = clampZoom(currentZoom - 1)
    await ctrlWheelZoomStep(page, viewport, zoomOutDelta)
    await expect.poll(async () => readZoomPercent(page)).toBe(expected)
    currentZoom = expected
  }

  for (let i = 0; i < 4; i += 1) {
    const expected = clampZoom(currentZoom + 1)
    await ctrlWheelZoomStep(page, viewport, zoomInDelta)
    await expect.poll(async () => readZoomPercent(page)).toBe(expected)
    currentZoom = expected
  }

  await dragZoomSliderTo(page, 10)
  await expect.poll(async () => readZoomPercent(page)).toBe(10)

  await dragZoomSliderTo(page, 100)
  await expect.poll(async () => readZoomPercent(page)).toBe(100)

  await dragZoomSliderTo(page, 55)
  await expect
    .poll(async () => readZoomPercent(page))
    .toBeGreaterThanOrEqual(10)
  await expect.poll(async () => readZoomPercent(page)).toBeLessThanOrEqual(100)
})
