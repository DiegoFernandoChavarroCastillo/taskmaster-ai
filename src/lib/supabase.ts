import { createClient } from '@supabase/supabase-js'
import type { Database } from './database.types'

/**
 * Cliente ÚNICO de Supabase, tipado con el esquema.
 *
 * Es el único punto de la app que llama a createClient: un segundo cliente
 * abriría otro WebSocket de Realtime y otra sesión de auth independiente.
 * Solo hooks/ y lib/ pueden importarlo; los componentes consumen hooks.
 */
const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !anonKey) {
  throw new Error(
    'Faltan VITE_SUPABASE_URL y/o VITE_SUPABASE_ANON_KEY. ' +
      'Copia .env.example a .env.local y rellena los valores de tu proyecto.',
  )
}

export const supabase = createClient<Database>(url, anonKey, {
  auth: { persistSession: true, autoRefreshToken: true },
})
