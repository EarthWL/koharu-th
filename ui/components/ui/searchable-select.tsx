'use client'

import * as React from 'react'
import { CheckIcon, ChevronDownIcon, SearchIcon, XIcon, Loader2Icon } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'

export type SearchableSelectOption = {
  value: string
  label: React.ReactNode
  /** Free text used for search match. Defaults to `value`. */
  searchText?: string
  /** Optional secondary line displayed under the label. */
  description?: React.ReactNode
  /** Optional trailing badge (e.g. price, context length). */
  trailing?: React.ReactNode
  disabled?: boolean
}

type Props = {
  value?: string
  onValueChange: (value: string) => void
  options: SearchableSelectOption[]
  placeholder?: string
  searchPlaceholder?: string
  emptyMessage?: React.ReactNode
  loading?: boolean
  loadingMessage?: React.ReactNode
  disabled?: boolean
  className?: string
  contentClassName?: string
  /** When true, allows the user to clear the current selection. */
  clearable?: boolean
}

/**
 * Searchable single-select combobox built on Radix Popover.
 *
 * Filtering is case-insensitive substring match on
 * `option.searchText ?? option.value` plus the string form of `option.label`.
 */
export function SearchableSelect({
  value,
  onValueChange,
  options,
  placeholder = 'Select…',
  searchPlaceholder = 'Search…',
  emptyMessage = 'No results',
  loading = false,
  loadingMessage = 'Loading…',
  disabled = false,
  className,
  contentClassName,
  clearable = false,
}: Props) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')

  const filtered = React.useMemo(() => {
    if (!query.trim()) return options
    const q = query.toLowerCase()
    return options.filter((o) => {
      const haystack = (
        (o.searchText ?? o.value) +
        ' ' +
        (typeof o.label === 'string' ? o.label : '')
      ).toLowerCase()
      return haystack.includes(q)
    })
  }, [options, query])

  const selected = options.find((o) => o.value === value)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          disabled={disabled}
          data-placeholder={selected ? undefined : ''}
          className={cn(
            "border-input bg-transparent data-[placeholder]:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 dark:bg-input/30 dark:hover:bg-input/50 flex h-7 w-full items-center justify-between gap-1.5 rounded-md border px-2 py-1 text-left text-xs shadow-xs transition outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
            className,
          )}
        >
          <span className='truncate'>
            {selected ? selected.label : placeholder}
          </span>
          <span className='flex items-center gap-1'>
            {clearable && selected && (
              <span
                role='button'
                aria-label='Clear selection'
                onClick={(e) => {
                  e.stopPropagation()
                  onValueChange('')
                }}
                className='text-muted-foreground hover:text-foreground'
              >
                <XIcon className='size-3.5' />
              </span>
            )}
            <ChevronDownIcon className='size-3.5 opacity-50' />
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align='start'
        className={cn('w-[var(--radix-popover-trigger-width)] p-0', contentClassName)}
      >
        <div className='border-border border-b p-2'>
          <div className='relative'>
            <SearchIcon className='text-muted-foreground absolute top-1/2 left-2 size-3.5 -translate-y-1/2' />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchPlaceholder}
              className='h-7 pl-7 text-xs'
            />
          </div>
        </div>
        <div className='max-h-72 overflow-y-auto p-1'>
          {loading ? (
            <div className='text-muted-foreground flex items-center justify-center gap-2 px-2 py-6 text-xs'>
              <Loader2Icon className='size-3.5 animate-spin' />
              <span>{loadingMessage}</span>
            </div>
          ) : filtered.length === 0 ? (
            <div className='text-muted-foreground px-2 py-6 text-center text-xs'>
              {emptyMessage}
            </div>
          ) : (
            filtered.map((opt) => {
              const active = opt.value === value
              return (
                <button
                  key={opt.value}
                  type='button'
                  disabled={opt.disabled}
                  onClick={() => {
                    onValueChange(opt.value)
                    setOpen(false)
                    setQuery('')
                  }}
                  className={cn(
                    'hover:bg-accent data-[active=true]:bg-accent/60 flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition disabled:cursor-not-allowed disabled:opacity-50',
                  )}
                  data-active={active}
                >
                  <CheckIcon
                    className={cn(
                      'mt-0.5 size-3.5 shrink-0',
                      active ? 'opacity-100' : 'opacity-0',
                    )}
                  />
                  <span className='min-w-0 flex-1'>
                    <span className='block truncate font-medium'>{opt.label}</span>
                    {opt.description && (
                      <span className='text-muted-foreground block truncate text-[10px]'>
                        {opt.description}
                      </span>
                    )}
                  </span>
                  {opt.trailing && (
                    <span className='text-muted-foreground shrink-0 text-[10px]'>
                      {opt.trailing}
                    </span>
                  )}
                </button>
              )
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
