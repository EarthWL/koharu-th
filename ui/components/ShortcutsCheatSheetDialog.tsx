'use client'

import { useTranslation } from 'react-i18next'
import { XIcon, KeyboardIcon } from 'lucide-react'
import { useEditorUiStore } from '@/lib/stores/editorUiStore'

export function ShortcutsCheatSheetDialog() {
  const { t } = useTranslation()
  const showShortcutsCheatSheet = useEditorUiStore(
    (state) => state.showShortcutsCheatSheet,
  )
  const setShowShortcutsCheatSheet = useEditorUiStore(
    (state) => state.setShowShortcutsCheatSheet,
  )

  if (!showShortcutsCheatSheet) return null

  const shortcutGroups = [
    {
      title: 'การแก้ไขข้อความ & ประวัติ (History)',
      items: [
        { keys: ['Ctrl', 'Z'], desc: 'ย้อนกลับ (Undo)' },
        { keys: ['Ctrl', 'Y'], desc: 'ทำซ้ำ (Redo)' },
        { keys: ['Ctrl', 'Alt', 'C'], desc: 'คัดลอกสไตล์อักษร' },
        { keys: ['Ctrl', 'Alt', 'V'], desc: 'วางสไตล์อักษร' },
      ],
    },
    {
      title: 'เครื่องมือและการทำงาน (Canvas & Tools)',
      items: [
        { keys: ['ดับเบิลคลิก'], desc: 'พิมพ์แปลข้อความทันที (เคาะสองครั้ง)' },
        { keys: ['?'], desc: 'เปิด/ปิด คู่มือคีย์ลัดนี้' },
        { keys: ['Delete'], desc: 'ลบกล่องข้อความที่เลือก' },
        { keys: ['Esc'], desc: 'ยกเลิกการเลือก/ล้างการเลือก' },
        { keys: ['Ctrl', '0'], desc: 'ซูมพอดีหน้าจอ (Fit Screen)' },
        { keys: ['Ctrl', '1'], desc: 'ซูมขนาดจริง 100% (Actual Size)' },
      ],
    },
    {
      title: 'การจัดตำแหน่ง & ทิศทาง (Nudging & Smart Guides)',
      items: [
        { keys: ['▲ / ▼ / ◄ / ►'], desc: 'ขยับกล่องข้อความครั้งละ 1px' },
        { keys: ['Shift', 'ลูกศร'], desc: 'ขยับกล่องข้อความครั้งละ 10px' },
        {
          keys: ['ลากเมาส์'],
          desc: 'สนิทขอบ/กึ่งกลาง (Smart Guides ลากเส้นชมพู)',
        },
      ],
    },
  ]

  return (
    <div
      className='fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm transition-all duration-300'
      onClick={() => setShowShortcutsCheatSheet(false)}
    >
      <div
        className='border-border/80 bg-background/90 text-foreground animate-in fade-in zoom-in-95 relative flex w-full max-w-lg flex-col rounded-xl border p-6 shadow-2xl backdrop-blur-md duration-200'
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close Button */}
        <button
          type='button'
          onClick={() => setShowShortcutsCheatSheet(false)}
          className='text-muted-foreground hover:text-foreground hover:bg-accent/40 absolute top-4 right-4 flex size-7 items-center justify-center rounded-md transition'
          title='ปิด'
        >
          <XIcon className='size-4' />
        </button>

        {/* Header */}
        <div className='mb-6 flex items-center gap-3 border-b pb-4'>
          <div className='bg-primary/10 text-primary flex size-10 shrink-0 items-center justify-center rounded-full'>
            <KeyboardIcon className='size-5' />
          </div>
          <div>
            <h2 className='text-base font-bold tracking-tight'>
              ทางลัดแป้นพิมพ์ (Keyboard Shortcuts)
            </h2>
            <p className='text-muted-foreground text-xs'>
              เพิ่มความรวดเร็วในการแปลมังงะแบบมืออาชีพ สไตล์ Photoshop
            </p>
          </div>
        </div>

        {/* Shortcuts List */}
        <div className='flex max-h-[350px] flex-col gap-5 overflow-y-auto pr-1'>
          {shortcutGroups.map((group, groupIdx) => (
            <div key={groupIdx} className='flex flex-col gap-2'>
              <h3 className='text-primary px-1 text-xs font-bold tracking-wide uppercase'>
                {group.title}
              </h3>
              <div className='bg-muted/30 border-border/40 overflow-hidden rounded-lg border'>
                {group.items.map((item, itemIdx) => (
                  <div
                    key={itemIdx}
                    className='border-border/30 hover:bg-muted/40 flex items-center justify-between border-b px-3 py-2 text-xs transition-colors last:border-b-0'
                  >
                    <span className='text-muted-foreground font-medium'>
                      {item.desc}
                    </span>
                    <div className='flex shrink-0 items-center gap-1 font-mono select-none'>
                      {item.keys.map((key, keyIdx) => (
                        <kbd
                          key={keyIdx}
                          className='bg-background border-border/80 rounded border px-1.5 py-0.5 text-[10px] font-bold shadow-xs'
                        >
                          {key}
                        </kbd>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className='mt-6 flex justify-end border-t pt-4'>
          <button
            type='button'
            onClick={() => setShowShortcutsCheatSheet(false)}
            className='bg-primary text-primary-foreground hover:bg-primary/95 inline-flex h-9 items-center justify-center rounded-lg px-5 text-xs font-semibold shadow-sm transition'
          >
            เข้าใจแล้ว
          </button>
        </div>
      </div>
    </div>
  )
}
