import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The lazy 3D host chunk (three.js, setup step 3 only) is ~900 kB; nothing else comes close.
export default defineConfig({ plugins: [react()], build: { chunkSizeWarningLimit: 1000 } })
