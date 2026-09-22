import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiError } from './api/client'

import 'uplot/dist/uPlot.min.css'
import './styles/base.css'
import './styles/console.css'
import { App } from './App'

// Nothing here polls. A shift only changes when the operator moves it, so
// every view is invalidated by the action that changed it and by nothing else.
const client = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 0,
      // A refusal the service meant — a shift that is gone, a request it will
      // not accept — does not become true on the second ask. Retrying it only
      // delays the explanation the operator is waiting for.
      retry: (count, error) =>
        !(error instanceof ApiError && error.status < 500) && count < 1,
    },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
