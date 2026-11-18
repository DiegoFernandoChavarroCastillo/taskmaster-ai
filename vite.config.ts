import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { visualizer } from 'rollup-plugin-visualizer'
import { defineConfig, loadEnv, type Plugin } from 'vite'

/**
 * HARDENING · Ninguna clave secreta puede acabar en el bundle.
 *
 * Todo lo que empieza por VITE_ se incrusta en el JS público. Si alguien pega
 * por error la service_role (JWT con role=service_role) o una secret key
 * (sb_secret_...), el build se detiene antes de publicar nada: esa clave
 * ignora RLS y daría acceso total a la base de datos.
 */
function forbidSecretKeys(env: Record<string, string>): Plugin {
  const isSecret = (value: string): boolean => {
    if (value.startsWith('sb_secret_')) return true
    const payload = value.split('.')[1]
    if (!payload) return false
    try {
      const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
      return typeof claims === 'object' && claims !== null && 'role' in claims && claims.role === 'service_role'
    } catch {
      return false
    }
  }
  return {
    name: 'taskmaster:forbid-secret-keys',
    configResolved() {
      const leaked = Object.entries(env).filter(([, value]) => isSecret(value)).map(([key]) => key)
      if (leaked.length > 0) {
        throw new Error(
          `Clave secreta de Supabase en variables públicas: ${leaked.join(', ')}. ` +
            'Usa solo la anon/publishable key en el frontend; la service_role va únicamente en el servidor.',
        )
      }
    },
  }
}

/**
 * HARDENING · Content-Security-Policy (solo en el build de producción; el
 * servidor de desarrollo necesita scripts inline para el HMR).
 * Limita de dónde se cargan scripts y a qué orígenes puede conectarse la app:
 * un XSS no podría exfiltrar datos a un dominio ajeno ni cargar scripts externos.
 */
function contentSecurityPolicy(supabaseUrl: string | undefined): Plugin {
  const origin = supabaseUrl ? new URL(supabaseUrl).host : '*.supabase.co'
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: https:",
    `connect-src 'self' https://${origin} wss://${origin}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ')
  return {
    name: 'taskmaster:csp',
    apply: 'build',
    transformIndexHtml: () => [
      { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: policy }, injectTo: 'head-prepend' },
      { tag: 'meta', attrs: { name: 'referrer', content: 'strict-origin-when-cross-origin' }, injectTo: 'head-prepend' },
    ],
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')

  return {
    plugins: [
      react(),
      tailwindcss(),
      forbidSecretKeys(env),
      contentSecurityPolicy(env.VITE_SUPABASE_URL),
      // `npm run analyze` → informe interactivo del bundle en dist/stats.html
      mode === 'analyze' &&
        visualizer({ filename: 'dist/stats.html', template: 'treemap', gzipSize: true, brotliSize: true, title: 'TaskMaster AI · bundle DESPUÉS' }),
    ],
    build: {
      // Sin `target` explícito: el valor por defecto de Vite 8
      // ('baseline-widely-available') es más moderno que 'es2022'. Probar
      // 'es2022' AUMENTÓ el CSS de 16,98 a 18,78 KB (más prefijos): descartado.
      rolldownOptions: {
        output: {
          // PERFORMANCE · Code splitting de dependencias.
          // Separar los vendors del código de la app permite que el navegador
          // los cachee entre despliegues (cambiar un componente ya no invalida
          // ~100 KB gzip de React + Supabase) y que se descarguen en paralelo.
          codeSplitting: {
            groups: [
              { name: 'vendor-react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 20 },
              { name: 'vendor-supabase', test: /node_modules[\\/](@supabase|iceberg-js|tslib)[\\/]/, priority: 10 },
            ],
          },
        },
      },
    },
  }
})
