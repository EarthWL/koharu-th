'use client'

// global-error.tsx — Next.js global error boundary (App Router).
// ported from mayocream/koharu; Sentry dependency removed since
// EarthWL/koharu-th does not use Sentry. Errors are logged to the
// browser console instead.

import NextError from 'next/error'
import { useEffect } from 'react'

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string }
}) {
  useEffect(() => {
    // Log to console in development; replace with your own error-reporting
    // service if desired (e.g. Sentry, LogRocket, Datadog).
    console.error('[GlobalError]', error)
  }, [error])

  return (
    <html lang='en'>
      <body>
        {/* `NextError` is the default Next.js error page component. Its type
        definition requires a `statusCode` prop. However, since the App Router
        does not expose status codes for errors, we simply pass 0 to render a
        generic error message. */}
        <NextError statusCode={0} />
      </body>
    </html>
  )
}
