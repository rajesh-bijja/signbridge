import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/signbridge/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Monaco (the Sandbox IDE's editor) is by far the largest dependency. It is
    // already behind the lazy /sandbox route, so it never touches the initial
    // load; splitting it into its own chunk additionally means editing our own
    // Sandbox code doesn't invalidate it in the browser cache.
    chunkSizeWarningLimit: 4500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Vite's preload helper is imported by the entry AND by every lazy
          // page chunk. Left to its own devices Rollup parked that tiny module
          // inside the monaco chunk, which made the 4.4 MB editor a *static*
          // dependency of the entry: index.html grew a modulepreload for it and
          // a blocking monaco stylesheet, so every route — dashboard, S3 World,
          // anything — paid for Monaco whether or not it opened an editor.
          // Giving the helper its own chunk cuts that edge and restores the
          // intended behaviour: Monaco loads only when /sandbox does.
          if (id.includes('vite/preload-helper')) return 'vite-preload'
          if (id.includes('node_modules/monaco-editor')) return 'monaco-editor'
          return undefined
        }
      }
    }
  },
  server: {
    port: 5173,
    proxy: {
      '/signbridge': {
        target: 'https://localhost:2443',
        secure: false,
        changeOrigin: true
      },
      '/socket.io': {
        target: 'https://localhost:2443',
        secure: false,
        ws: true
      }
    }
  }
})
