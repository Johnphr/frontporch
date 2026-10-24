import React from 'react'
import { createRoot } from 'react-dom/client'
import { ConvexProvider, ConvexReactClient } from 'convex/react'
import App from './App.jsx'
import './index.css'

const url = import.meta.env.VITE_CONVEX_URL
const root = createRoot(document.getElementById('root'))

if (!url) {
  console.error('VITE_CONVEX_URL is not set. Copy web/.env.example to web/.env.local.')
  root.render(
    <p className="p-6 text-xl">
      Falta configurar VITE_CONVEX_URL. / VITE_CONVEX_URL is not set.
    </p>,
  )
} else {
  const convex = new ConvexReactClient(url)
  root.render(
    <React.StrictMode>
      <ConvexProvider client={convex}>
        <App />
      </ConvexProvider>
    </React.StrictMode>,
  )
}
