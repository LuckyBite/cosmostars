import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import 'uplot/dist/uPlot.min.css'
import './styles/base.css'
import './styles/console.css'
import { App } from './App'

// Nothing here polls. A shift only changes when the operator moves it, so
// every view is invalidated by the action that changed it and by nothing else.
const client = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, retry: 1, staleTime: 0 },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
