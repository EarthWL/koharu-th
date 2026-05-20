'use client'

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * Render assistant chat content as GFM markdown so tables / fences /
 * lists actually look like tables/code/lists instead of ASCII pipes.
 *
 * - User text is always selectable (`select-text`) — was previously
 *   ambiguous because plain `<div>` inherited the sidebar's drag
 *   behaviour.
 * - Tables overflow horizontally with their own scrollbar so long rows
 *   don't burst the sidebar width.
 * - Code blocks wrap or scroll instead of pushing the panel wider.
 */
export function ChatMarkdown({ children }: { children: string }) {
  return (
    <div className='chat-md text-xs leading-relaxed break-words select-text'>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Wrap tables in a scroll container so a wide markdown table
          // doesn't push the whole chat panel wider than the sidebar.
          table: ({ node, ...props }) => (
            <div className='-mx-0.5 my-1.5 overflow-x-auto'>
              <table
                {...props}
                className='border-border w-full border-collapse border text-[11px]'
              />
            </div>
          ),
          thead: ({ node, ...props }) => (
            <thead {...props} className='bg-muted/60' />
          ),
          th: ({ node, ...props }) => (
            <th
              {...props}
              className='border-border border px-1.5 py-1 text-left font-semibold'
            />
          ),
          td: ({ node, ...props }) => (
            <td
              {...props}
              className='border-border border px-1.5 py-1 align-top'
            />
          ),
          code: ({ node, className, children, ...props }) => {
            const isInline = !/language-/.test(className ?? '')
            if (isInline) {
              return (
                <code
                  {...props}
                  className='bg-muted rounded px-1 py-0.5 font-mono text-[10.5px]'
                >
                  {children}
                </code>
              )
            }
            return (
              <code {...props} className={className}>
                {children}
              </code>
            )
          },
          pre: ({ node, ...props }) => (
            <pre
              {...props}
              className='bg-muted my-1.5 max-h-60 overflow-auto rounded p-2 text-[10.5px]'
            />
          ),
          ul: ({ node, ...props }) => (
            <ul {...props} className='my-1 list-disc space-y-0.5 pl-4' />
          ),
          ol: ({ node, ...props }) => (
            <ol {...props} className='my-1 list-decimal space-y-0.5 pl-4' />
          ),
          p: ({ node, ...props }) => (
            <p {...props} className='my-1 first:mt-0 last:mb-0' />
          ),
          a: ({ node, ...props }) => (
            <a
              {...props}
              target='_blank'
              rel='noreferrer'
              className='text-primary underline underline-offset-2 hover:no-underline'
            />
          ),
          h1: ({ node, ...props }) => (
            <h1 {...props} className='mt-2 mb-1 text-sm font-bold' />
          ),
          h2: ({ node, ...props }) => (
            <h2 {...props} className='mt-2 mb-1 text-xs font-bold' />
          ),
          h3: ({ node, ...props }) => (
            <h3 {...props} className='mt-1.5 mb-0.5 text-xs font-semibold' />
          ),
          blockquote: ({ node, ...props }) => (
            <blockquote
              {...props}
              className='border-border text-muted-foreground my-1.5 border-l-2 pl-2 italic'
            />
          ),
          hr: ({ node, ...props }) => (
            <hr {...props} className='border-border my-2' />
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
