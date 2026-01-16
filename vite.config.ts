import { defineConfig, loadEnv } from 'vite'
import mkcert from 'vite-plugin-mkcert'

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  const port = Number(env.VITE_DEV_SERVER_PORT) || 5173
  const infinityTarget = env.VITE_INFINITY_TARGET

  const manifestContent = {
    images: {},
    translations: {},
    plugins: [
      {
        src: `https://localhost:${port}`,
        sandboxValues: ['allow-same-origin']
      }
    ]
  }
  const manifest = JSON.stringify(manifestContent)

  if (mode === 'development') {
    if (!infinityTarget) {
      console.error('\n❌ Configuration Error: Missing Pexip Infinity URL ❌\n')
      console.error(
        'To run the dev server, create a .env file in the project root with:\n'
      )
      console.error(
        'VITE_INFINITY_TARGET=https://your-pexip-infinity-server.com\n'
      )
      console.error(
        'See .env.example for reference or README.md for details.\n'
      )
      throw new Error('VITE_INFINITY_TARGET is not defined in .env file')
    }
  }

  return {
    base: './',
    build: {
      target: 'esnext',
      rollupOptions: {
        output: {
          entryFileNames: `assets/[name].js`
        }
      }
    },

    plugins: [
      mkcert(),
      // Inline manifest.json: serve in dev
      {
        name: 'inline-manifest',
        apply: 'serve', // only during dev
        configureServer(server) {
          server.middlewares.use(
            '/webapp3/branding/manifest.json',
            (req, res) => {
              res.setHeader('Content-Type', 'application/json')
              res.end(manifest)
            }
          )
        }
      }
    ],

    server: {
      open: '/webapp3/',
      allowedHosts: ['localhost'],
      port: port,
      proxy: {
        '/api': {
          target: infinityTarget,
          changeOrigin: true,
          secure: false
        },
        '/webapp3': {
          target: infinityTarget,
          changeOrigin: true,
          secure: false
        }
      }
    }
  }
})
