'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { MinusIcon, SquareIcon, XIcon, CopyIcon } from 'lucide-react'
import { isTauri, isMacOS, windowControls } from '@/lib/backend'
import { useTranslation } from 'react-i18next'
import { fitCanvasToViewport, resetCanvasScale } from '@/components/Canvas'
import Image from 'next/image'
import {
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarSeparator,
  MenubarTrigger,
} from '@/components/ui/menubar'
import { useDocumentMutations } from '@/lib/query/mutations'
import { useProjectMutations } from '@/lib/query/projectMutations'
import { useProjectStore } from '@/lib/stores/projectStore'
import { useEditorUiStore } from '@/lib/stores/editorUiStore'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { checkForUpdates } from '@/lib/services/updateCheck'
import { flushAllSyncQueues } from '@/lib/services/syncQueues'

type MenuItem = {
  label: string
  onSelect?: () => void | Promise<void>
  disabled?: boolean
  testId?: string
}

type MenuSection = {
  label: string
  items: MenuItem[]
  triggerTestId?: string
}

export function MenuBar() {
  const { t } = useTranslation()
  const {
    addDocuments,
    openDocuments,
    openExternal,
    processImage,
    retranslateImage,
    inpaintAndRenderImage,
    processAllImages,
    exportDocument,
    exportAllInpainted,
    exportAllRendered,
  } = useDocumentMutations()
  const projectInfo = useProjectStore((s) => s.info)
  const totalPages = useEditorUiStore((s) => s.totalPages)
  const hasDocument = totalPages > 0
  const { refreshCurrent, openPicker, closeProject } = useProjectMutations()
  const recentProjects = useQuery({
    queryKey: ['recent-projects'],
    queryFn: () => api.recentProjectsList(),
    staleTime: 30_000,
  })

  // Sync the project store with backend state on mount so the menu always
  // reflects reality (e.g. after a hot reload).
  useEffect(() => {
    void refreshCurrent()
  }, [refreshCurrent])

  const recentList = recentProjects.data ?? []
  const projectMenuItems: MenuItem[] = [
    {
      label: t('menu.openProject'),
      onSelect: () => {
        // Drain pending writes before swapping the project — pending
        // text-block / mask / brush edits target the OUTGOING project;
        // openPicker() resets stores on success and orphans them.
        // Recent-project and Close already do this; Open was missed.
        void (async () => {
          await flushAllSyncQueues().catch(() => {})
          void openPicker()
        })()
      },
    },
    ...recentList.slice(0, 6).map((p) => ({
      label: `↩ ${p.name}`,
      onSelect: () => {
        void (async () => {
          try {
            // Drain pending text-block / mask / brush writes before swapping
            // the project out from under them — otherwise in-flight edits to
            // the old project get orphaned by the store swap.
            await flushAllSyncQueues().catch(() => {})
            const info = await api.projectOpen(p.path)
            useProjectStore.getState().setInfo(info)
            void refreshCurrent()
          } catch (err: any) {
            alert(err?.message ?? String(err))
          }
        })()
      },
    })),
    {
      label: t('menu.closeProject'),
      onSelect: () => {
        // Drain pending writes before tearing down the project — the close
        // flow resets stores, which would otherwise discard in-flight edits.
        void (async () => {
          await flushAllSyncQueues().catch(() => {})
          void closeProject()
        })()
      },
      disabled: !projectInfo,
    },
  ]

  const fileMenuItems: MenuItem[] = [
    {
      label: t('menu.openFile'),
      onSelect: openDocuments,
      testId: 'menu-file-open',
    },
    {
      label: t('menu.addFile'),
      onSelect: addDocuments,
      testId: 'menu-file-add',
    },
    {
      label: t('menu.export'),
      onSelect: exportDocument,
      testId: 'menu-file-export',
      disabled: !hasDocument,
    },
    {
      label: t('menu.exportAllInpainted'),
      onSelect: exportAllInpainted,
      testId: 'menu-file-export-all-inpainted',
      disabled: !hasDocument,
    },
    {
      label: t('menu.exportAllRendered'),
      onSelect: exportAllRendered,
      testId: 'menu-file-export-all-rendered',
      disabled: !hasDocument,
    },
  ]

  const menus: MenuSection[] = [
    {
      label: t('menu.view'),
      items: [
        {
          label: t('menu.fitWindow'),
          onSelect: fitCanvasToViewport,
          disabled: !hasDocument,
        },
        {
          label: t('menu.originalSize'),
          onSelect: resetCanvasScale,
          disabled: !hasDocument,
        },
        {
          label: t('menu.qaReview'),
          onSelect: () => {
            window.location.href = '/qa'
          },
          disabled: !projectInfo,
        },
      ],
    },
    {
      label: t('menu.process'),
      triggerTestId: 'menu-process-trigger',
      items: [
        {
          label: t('menu.processCurrent'),
          onSelect: processImage,
          testId: 'menu-process-current',
          disabled: !hasDocument,
        },
        {
          // Re-translate: skips Detect / OCR / Inpaint, only re-runs
          // LLM translation + Render. Useful when iterating on prompts
          // or trying a different model — Inpaint is the slowest step
          // and the inpainted image hasn't changed since first Process.
          // Issue #17.
          label: t('menu.retranslate'),
          onSelect: retranslateImage,
          testId: 'menu-process-retranslate',
          disabled: !hasDocument,
        },
        {
          label: t('menu.redoInpaintRender'),
          onSelect: inpaintAndRenderImage,
          testId: 'menu-process-rerender',
          disabled: !hasDocument,
        },
        {
          label: t('menu.processAll'),
          onSelect: processAllImages,
          testId: 'menu-process-all',
          disabled: !hasDocument,
        },
      ],
    },
  ]

  const runUpdateCheck = async () => {
    let current = '0.0.0'
    try {
      current = (await api.appVersion()) ?? '0.0.0'
    } catch {}
    const result = await checkForUpdates(current)
    if (result.kind === 'up-to-date') {
      alert(
        t('menu.updateUpToDate', {
          current: result.currentVersion,
          latest: result.latestVersion,
        }),
      )
      return
    }
    if (result.kind === 'error') {
      alert(t('menu.updateCheckFailed', { message: result.message }))
      return
    }
    const open = confirm(
      t('menu.updateAvailableConfirm', {
        current: result.currentVersion,
        latest: result.latestVersion,
      }),
    )
    if (open) openExternal(result.releaseUrl)
  }

  const helpMenuItems: MenuItem[] = [
    {
      label: t('menu.checkForUpdates'),
      onSelect: () => void runUpdateCheck(),
    },
    {
      label: t('menu.github'),
      onSelect: () => openExternal('https://github.com/EarthWL/koharu-th'),
    },
    {
      label: t('menu.reportIssue'),
      onSelect: () =>
        openExternal('https://github.com/EarthWL/koharu-th/issues/new'),
    },
    {
      label: t('menu.upstreamDiscord'),
      onSelect: () => openExternal('https://discord.gg/mHvHkxGnUY'),
    },
  ]

  const isNativeMacOS = isTauri() && isMacOS()
  const isWindowsTauri = isTauri() && !isMacOS()

  return (
    <div className='border-border bg-background text-foreground flex h-8 items-center border-b text-[13px]'>
      {/* macOS traffic lights */}
      {isNativeMacOS && <MacOSControls />}

      {/* Logo */}
      <div className='flex h-full items-center pl-2 select-none'>
        <Image
          src='/icon.png'
          alt='Koharu'
          width={18}
          height={18}
          draggable={false}
        />
      </div>

      {/* Menu items */}
      <Menubar className='h-auto gap-1 border-none bg-transparent p-0 px-1.5 shadow-none'>
        <MenubarMenu>
          <MenubarTrigger
            data-testid='menu-file-trigger'
            className='hover:bg-accent data-[state=open]:bg-accent rounded px-3 py-1.5 font-medium'
          >
            {t('menu.file')}
          </MenubarTrigger>
          <MenubarContent
            className='min-w-36'
            align='start'
            sideOffset={5}
            alignOffset={-3}
          >
            {fileMenuItems.map((item) => (
              <MenubarItem
                key={item.label}
                data-testid={item.testId}
                className='text-[13px]'
                disabled={item.disabled}
                onSelect={
                  item.onSelect
                    ? () => {
                        void item.onSelect?.()
                      }
                    : undefined
                }
              >
                {item.label}
              </MenubarItem>
            ))}
            <MenubarSeparator />
            <MenubarItem className='text-[13px]' asChild>
              <Link href='/settings' prefetch={false}>
                {t('menu.settings')}
              </Link>
            </MenubarItem>
          </MenubarContent>
        </MenubarMenu>
        <MenubarMenu>
          <MenubarTrigger className='hover:bg-accent data-[state=open]:bg-accent rounded px-3 py-1.5 font-medium'>
            {t('menu.project')}
          </MenubarTrigger>
          <MenubarContent
            className='min-w-44'
            align='start'
            sideOffset={5}
            alignOffset={-3}
          >
            {projectMenuItems.map((item) => (
              <MenubarItem
                key={item.label}
                className='text-[13px]'
                disabled={item.disabled}
                onSelect={
                  item.onSelect
                    ? () => {
                        void item.onSelect?.()
                      }
                    : undefined
                }
              >
                {item.label}
              </MenubarItem>
            ))}
          </MenubarContent>
        </MenubarMenu>
        {menus.map(({ label, items, triggerTestId }) => (
          <MenubarMenu key={label}>
            <MenubarTrigger
              data-testid={triggerTestId}
              className='hover:bg-accent data-[state=open]:bg-accent rounded px-3 py-1.5 font-medium'
            >
              {label}
            </MenubarTrigger>
            <MenubarContent
              className='min-w-36'
              align='start'
              sideOffset={5}
              alignOffset={-3}
            >
              {items.map((item) => (
                <MenubarItem
                  key={item.label}
                  data-testid={item.testId}
                  className='text-[13px]'
                  disabled={item.disabled}
                  onSelect={
                    item.onSelect
                      ? () => {
                          void item.onSelect?.()
                        }
                      : undefined
                  }
                >
                  {item.label}
                </MenubarItem>
              ))}
            </MenubarContent>
          </MenubarMenu>
        ))}
        <MenubarMenu>
          <MenubarTrigger className='hover:bg-accent data-[state=open]:bg-accent rounded px-3 py-1.5 font-medium'>
            {t('menu.help')}
          </MenubarTrigger>
          <MenubarContent
            className='min-w-36'
            align='start'
            sideOffset={5}
            alignOffset={-3}
          >
            {helpMenuItems.map((item) => (
              <MenubarItem
                key={item.label}
                className='text-[13px]'
                disabled={item.disabled}
                onSelect={
                  item.onSelect
                    ? () => {
                        void item.onSelect?.()
                      }
                    : undefined
                }
              >
                {item.label}
              </MenubarItem>
            ))}
            <MenubarSeparator />
            <MenubarItem className='text-[13px]' asChild>
              <Link href='/about' prefetch={false}>
                {t('settings.about')}
              </Link>
            </MenubarItem>
          </MenubarContent>
        </MenubarMenu>
      </Menubar>

      {/* Draggable region + project indicator */}
      <div
        data-tauri-drag-region
        className='flex h-full flex-1 items-center justify-center'
      >
        {projectInfo && <ProjectIndicator />}
      </div>

      {/* Window controls for Windows */}
      {isWindowsTauri && <WindowControls />}
    </div>
  )
}

function ProjectIndicator() {
  const projectInfo = useProjectStore((s) => s.info)
  const activeChapterId = useProjectStore((s) => s.activeChapterId)
  if (!projectInfo) return null
  return (
    <span className='text-muted-foreground pointer-events-auto text-[11px] font-medium'>
      📁 {projectInfo.name}
      <span className='text-muted-foreground/70 ml-1'>
        · {projectInfo.chapterCount} ch
      </span>
      {activeChapterId !== null && (
        <span className='text-primary/80 ml-1'>· 📍 active</span>
      )}
    </span>
  )
}

function MacOSControls() {
  return (
    <div className='flex h-full items-center gap-2 pr-2 pl-4'>
      <button
        onClick={() => void windowControls.close()}
        className='group flex size-3 items-center justify-center rounded-full bg-[#FF5F57] active:bg-[#bf4942]'
      >
        <XIcon
          className='size-2 text-[#4a0002] opacity-0 group-hover:opacity-100'
          strokeWidth={3}
        />
      </button>
      <button
        onClick={() => void windowControls.minimize()}
        className='group flex size-3 items-center justify-center rounded-full bg-[#FEBC2E] active:bg-[#bf8d22]'
      >
        <MinusIcon
          className='size-2 text-[#5f4a00] opacity-0 group-hover:opacity-100'
          strokeWidth={3}
        />
      </button>
      <button
        onClick={() => void windowControls.toggleMaximize()}
        className='group flex size-3 items-center justify-center rounded-full bg-[#28C840] active:bg-[#1e9630]'
      >
        <SquareIcon
          className='size-1.5 text-[#006500] opacity-0 group-hover:opacity-100'
          strokeWidth={3}
        />
      </button>
    </div>
  )
}

function WindowControls() {
  const [maximized, setMaximized] = useState(false)

  const updateMaximized = useCallback(async () => {
    setMaximized(await windowControls.isMaximized())
  }, [])

  useEffect(() => {
    void updateMaximized()
    // Sync maximize state on window resize (snap, double-click titlebar, etc.)
    const onResize = () => void updateMaximized()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [updateMaximized])

  return (
    <div className='flex h-full'>
      <button
        onClick={() => void windowControls.minimize()}
        className='hover:bg-accent flex h-full w-11 items-center justify-center'
      >
        <MinusIcon className='size-4' />
      </button>
      <button
        onClick={() => {
          void windowControls.toggleMaximize().then(updateMaximized)
        }}
        className='hover:bg-accent flex h-full w-11 items-center justify-center'
      >
        {maximized ? (
          <CopyIcon className='size-3.5' />
        ) : (
          <SquareIcon className='size-3.5' />
        )}
      </button>
      <button
        onClick={() => void windowControls.close()}
        className='flex h-full w-11 items-center justify-center hover:bg-red-500 hover:text-white'
      >
        <XIcon className='size-4' />
      </button>
    </div>
  )
}
