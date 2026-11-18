import type { RealtimeChannel, RealtimePostgresChangesPayload } from '@supabase/supabase-js'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { TableName } from '../lib/database.types'
import { isAbortError, translateError } from '../lib/errors'
import { supabase } from '../lib/supabase'

/* -------------------------------------------------------------------------- */
/* Tipos públicos                                                             */
/* -------------------------------------------------------------------------- */

/** Fila mínima que el hook sabe gestionar: identificable por id. */
export type Row = { id: string } & Record<string, unknown>

/**
 * Estado de la lista como unión discriminada por `status`.
 * Solo la rama 'error' tiene `error: string`, así que el consumidor
 * está obligado a comprobar el status antes de leerlo.
 */
export type ListState<T> =
  | { status: 'idle'; data: readonly T[]; error: null }
  | { status: 'loading'; data: readonly T[]; error: null }
  | { status: 'success'; data: readonly T[]; error: null }
  | { status: 'error'; data: readonly T[]; error: string }

export type ListStatus = ListState<unknown>['status']

/** Estado del canal de Realtime, útil para un indicador "en vivo". */
export type RealtimeStatus = 'off' | 'connecting' | 'live' | 'reconnecting'

/** Resultado de un builder de PostgREST (es thenable). */
export type QueryResult<T> = PromiseLike<{ data: T[] | null; error: unknown }>

export interface RealtimeListOptions<T extends Row> {
  /** Tabla de Postgres que se escucha. */
  table: TableName
  /** Ámbito de la lista; genera el canal `${table}:${value}` y el filtro `${column}=eq.${value}`. */
  filter: { column: string; value: string } | null
  /** Consulta inicial. Recibe un AbortSignal que el hook cancela al desmontar o cambiar de ámbito. */
  query: (signal: AbortSignal) => QueryResult<T>
  /** Orden en memoria tras cada parche. */
  sort?: (a: T, b: T) => number
  /** Decide si `incoming` es más reciente que `current` (orden de eventos). */
  isNewer?: (incoming: T, current: T) => boolean
  /**
   * 'patch' (por defecto): cada evento se aplica sobre la lista en memoria.
   * 'refetch': cada evento dispara una recarga silenciosa. Para listas cuya
   * fila no coincide con la de la tabla escuchada (p. ej. miembros = join
   * project_members + profiles).
   */
  strategy?: 'patch' | 'refetch'
  /** false desactiva fetch y suscripción (p. ej. sin projectId). */
  enabled?: boolean
}

export type Updater<T> = (rows: readonly T[]) => readonly T[]

export type RealtimeList<T> = ListState<T> & {
  /** Vuelve a pedir la lista. `silent` mantiene los datos visibles (sin skeleton). */
  refetch: (options?: { silent?: boolean }) => Promise<void>
  /** Parche local (actualizaciones optimistas). Usa siempre la forma funcional. */
  mutate: (updater: Updater<T>) => void
  realtime: RealtimeStatus
}

/* -------------------------------------------------------------------------- */
/* Utilidades puras                                                           */
/* -------------------------------------------------------------------------- */

interface OrderOptions<T> {
  isNewer?: (incoming: T, current: T) => boolean
  sort?: (a: T, b: T) => number
}

function sortRows<T>(rows: readonly T[], sort?: (a: T, b: T) => number): readonly T[] {
  return sort ? [...rows].sort(sort) : rows
}

/**
 * Inserta o reemplaza una fila comparando por id (nunca por índice).
 * Si ya existe y `isNewer` dice que la entrante no es más reciente, se ignora.
 */
export function upsertById<T extends Row>(
  rows: readonly T[],
  incoming: T,
  options: OrderOptions<T> = {},
): readonly T[] {
  const index = rows.findIndex((row) => row.id === incoming.id)
  if (index === -1) return sortRows([...rows, incoming], options.sort)
  const current = rows[index]
  if (current && options.isNewer && !options.isNewer(incoming, current)) return rows
  return sortRows(rows.with(index, incoming), options.sort)
}

/**
 * Aplica un evento postgres_changes a la lista. Función pura: recibe la lista
 * ANTERIOR (desde el setState funcional) y devuelve la nueva. Si no hay
 * cambios devuelve la misma referencia y React omite el re-render.
 */
export function applyRealtimeChange<T extends Row>(
  rows: readonly T[],
  payload: RealtimePostgresChangesPayload<T>,
  options: OrderOptions<T> = {},
): readonly T[] {
  switch (payload.eventType) {
    case 'INSERT': {
      // PROBLEMA 1 · DEDUPLICACIÓN
      // Quien hace el insert recibe también su propio evento INSERT (y puede
      // llegar antes o después de la respuesta de .select().single()). Si ese
      // id ya está en memoria, el evento se descarta. Se compara por id y no
      // por índice: las posiciones cambian con cada inserción/ordenación.
      if (rows.some((row) => row.id === payload.new.id)) return rows
      return sortRows([...rows, payload.new], options.sort)
    }
    case 'UPDATE': {
      // PROBLEMA 3 · ORDEN
      // Los eventos pueden llegar desordenados o tarde (reintentos, latencia,
      // la respuesta de nuestra propia mutación ya aplicada). upsertById solo
      // aplica el UPDATE si `isNewer` (updated_at del evento > updated_at en
      // memoria) lo confirma, así un evento tardío no pisa un cambio más nuevo.
      // Si la fila no está en memoria (p. ej. su INSERT se perdió) se añade.
      return upsertById(rows, payload.new, options)
    }
    case 'DELETE': {
      // Con RLS activa Supabase solo envía la clave primaria en payload.old
      // (ver comentario de REPLICA IDENTITY en la migración): se borra por id.
      const id = payload.old.id
      if (!id || !rows.some((row) => row.id === id)) return rows
      return rows.filter((row) => row.id !== id)
    }
  }
}

/**
 * Combina la instantánea del servidor con lo que hay en memoria: manda el
 * servidor, salvo que en memoria exista una versión más reciente de la misma
 * fila (llegó por Realtime mientras la petición viajaba).
 */
function mergeSnapshot<T extends Row>(
  local: readonly T[],
  server: readonly T[],
  { isNewer, sort }: OrderOptions<T>,
): readonly T[] {
  if (!isNewer || local.length === 0) return sortRows(server, sort)
  const localById = new Map(local.map((row) => [row.id, row]))
  const merged = server.map((row) => {
    const mine = localById.get(row.id)
    return mine && isNewer(mine, row) ? mine : row
  })
  return sortRows(merged, sort)
}

/* -------------------------------------------------------------------------- */
/* Gestión del canal                                                          */
/* -------------------------------------------------------------------------- */

interface ChannelEntry {
  topic: string
  channel: RealtimeChannel
  disposeTimer: ReturnType<typeof setTimeout> | null
}

/** Cierra el canal: removeChannel hace unsubscribe + teardown del socket. */
function closeChannel(entry: ChannelEntry): void {
  if (entry.disposeTimer !== null) clearTimeout(entry.disposeTimer)
  entry.disposeTimer = null
  void supabase.removeChannel(entry.channel)
}

/**
 * supabase.channel(topic) DEVUELVE EL CANAL EXISTENTE si ya hay uno con ese
 * topic, y removeChannel es asíncrono (el canal sigue registrado hasta que el
 * servidor confirma la baja). Si un canal "zombi" con el mismo topic sigue
 * cerrándose, añadir .on() sobre él lanzaría "cannot add postgres_changes
 * callbacks after subscribe()". En ese caso límite se usa un topic único.
 */
function freeTopic(base: string): string {
  const taken = new Set(supabase.getChannels().map((channel) => channel.topic))
  if (!taken.has(`realtime:${base}`)) return base
  let n = 2
  while (taken.has(`realtime:${base}#${n}`)) n += 1
  return `${base}#${n}`
}

/* -------------------------------------------------------------------------- */
/* Hook                                                                       */
/* -------------------------------------------------------------------------- */

const INITIAL: ListState<never> = { status: 'idle', data: [], error: null }
const LOADING: ListState<never> = { status: 'loading', data: [], error: null }
const REFETCH_DEBOUNCE_MS = 150
const FOCUS_REFETCH_MIN_INTERVAL_MS = 2_000

/**
 * Hook genérico: fetch inicial + estado + suscripción a postgres_changes.
 * Ningún componente necesita conocer supabase-js: solo consumen este hook
 * a través de hooks de dominio (useTasks, useComments, useProjectMembers).
 */
export function useRealtimeList<T extends Row>(options: RealtimeListOptions<T>): RealtimeList<T> {
  const { table, filter, enabled = true } = options
  const filterColumn = filter?.column ?? null
  const filterValue = filter?.value ?? null

  const scopeKey = enabled ? `${table}|${filterColumn ?? ''}|${filterValue ?? ''}` : null
  const [state, setState] = useState<ListState<T>>(() => (scopeKey === null ? INITIAL : LOADING))
  const [realtime, setRealtime] = useState<RealtimeStatus>(scopeKey === null ? 'off' : 'connecting')

  // CAMBIO DE ÁMBITO (p. ej. otro projectId): el estado se reinicia DURANTE
  // el render (patrón recomendado por React frente a setState en un efecto),
  // así no se pinta ni un frame con las filas del proyecto anterior.
  const [currentScope, setCurrentScope] = useState(scopeKey)
  if (currentScope !== scopeKey) {
    setCurrentScope(scopeKey)
    setState(scopeKey === null ? INITIAL : LOADING)
    setRealtime(scopeKey === null ? 'off' : 'connecting')
  }

  // Las opciones (query, sort, isNewer) suelen ser closures nuevas en cada
  // render. Se guardan en una ref para leer siempre la última versión sin
  // tener que reiniciar efectos ni re-suscribir el canal.
  const optionsRef = useRef(options)
  useLayoutEffect(() => {
    optionsRef.current = options
  })

  // Controlador de la petición en curso: permite cancelarla al desmontar,
  // al cambiar de ámbito o cuando una petición más nueva la reemplaza.
  const abortRef = useRef<AbortController | null>(null)
  const lastLoadAtRef = useRef(0)

  // Canal activo. Vive en una ref (no en estado) porque no afecta al render
  // y porque el guard de StrictMode necesita verlo entre montaje y montaje.
  const channelRef = useRef<ChannelEntry | null>(null)
  const refetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /**
   * Programa el cierre del canal para el siguiente tick (ver guard de
   * StrictMode). Si nadie lo reclama antes, se llama a removeChannel.
   */
  const scheduleClose = useCallback((target: ChannelEntry): void => {
    target.disposeTimer = setTimeout(() => {
      if (refetchTimerRef.current !== null) clearTimeout(refetchTimerRef.current)
      refetchTimerRef.current = null
      // LIMPIEZA: supabase.removeChannel(channel) → sin fugas de memoria
      // ni sockets abiertos tras desmontar.
      closeChannel(target)
      if (channelRef.current === target) channelRef.current = null
    }, 0)
  }, [])

  const load = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    lastLoadAtRef.current = Date.now()
    const { query, sort, isNewer } = optionsRef.current

    if (!silent) setState((prev) => ({ status: 'loading', data: prev.data, error: null }))

    try {
      const { data, error } = await query(controller.signal)
      // Equivale a una bandera isMounted: si el componente se desmontó, cambió
      // el ámbito o llegó una petición más nueva, esta respuesta se descarta y
      // no se hace setState sobre un árbol que ya no existe.
      if (controller.signal.aborted) return
      if (error) {
        if (isAbortError(error)) return
        setState((prev) => ({ status: 'error', data: prev.data, error: translateError(error) }))
        return
      }
      setState((prev) => ({
        status: 'success',
        data: mergeSnapshot(prev.data, data ?? [], { isNewer, sort }),
        error: null,
      }))
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) return
      setState((prev) => ({ status: 'error', data: prev.data, error: translateError(error) }))
    } finally {
      if (abortRef.current === controller) abortRef.current = null
    }
  }, [])

  const mutate = useCallback((updater: Updater<T>) => {
    setState((prev) => ({ ...prev, data: sortRows(updater(prev.data), optionsRef.current.sort) }))
  }, [])

  /* ---------------------------- Fetch inicial ---------------------------- */
  // Se repite cuando cambia el ámbito (tabla / filtro).
  useEffect(() => {
    if (!enabled) return
    // El estado ya se puso en 'loading' al detectar el ámbito nuevo; la
    // petición es "silenciosa" para no repetir esa transición.
    // Falso positivo del linter: con silent=true load() solo hace setState
    // DESPUÉS del await (sincronización con un sistema externo).
    // oxlint-disable-next-line react/set-state-in-effect
    void load({ silent: true })
    return () => {
      abortRef.current?.abort()
      abortRef.current = null
    }
  }, [table, filterColumn, filterValue, enabled, load])

  /* ----------------------------- Suscripción ----------------------------- */
  useEffect(() => {
    if (!enabled) return

    const baseTopic = filterValue === null ? table : `${table}:${filterValue}`

    // GUARD DE STRICTMODE
    // En desarrollo React monta → desmonta → vuelve a montar cada efecto. La
    // limpieza no cierra el canal en el acto: programa el cierre en el
    // siguiente tick. Si el re-montaje llega antes con el MISMO topic, se
    // cancela el cierre y se reutiliza el canal: nunca hay dos suscripciones
    // activas ni se pierde el registro de handlers.
    const previous = channelRef.current
    if (previous && previous.topic === baseTopic && previous.disposeTimer !== null) {
      clearTimeout(previous.disposeTimer)
      previous.disposeTimer = null
      return () => scheduleClose(previous)
    }

    // CAMBIO DE PROYECTO: el canal anterior se cierra YA, antes de abrir el
    // nuevo. Así nunca quedan canales huérfanos escuchando otro proyecto.
    if (previous) {
      closeChannel(previous)
      channelRef.current = null
    }

    let hasConnected = false
    // Un canal que ya no es el vigente (proyecto anterior cerrándose, o
    // componente desmontado) puede recibir aún algún evento en vuelo mientras
    // removeChannel termina: se ignora para no mezclar datos entre ámbitos.
    const isCurrent = (): boolean => channelRef.current?.channel === channel

    // PROBLEMA 2 · CIERRES OBSOLETOS
    // Este handler se registra UNA sola vez por canal; si leyera `state`
    // directamente vería para siempre la lista del primer render. Por eso
    // nunca lee estado: delega en setState FUNCIONAL, que recibe la lista
    // vigente, y lee opciones desde optionsRef (siempre la última versión).
    const handleChange = (payload: RealtimePostgresChangesPayload<T>): void => {
      if (!isCurrent()) return
      const { strategy = 'patch', isNewer, sort } = optionsRef.current
      if (strategy === 'refetch') {
        if (refetchTimerRef.current !== null) clearTimeout(refetchTimerRef.current)
        refetchTimerRef.current = setTimeout(() => void load({ silent: true }), REFETCH_DEBOUNCE_MS)
        return
      }
      setState((prev) => {
        const data = applyRealtimeChange(prev.data, payload, { isNewer, sort })
        return data === prev.data ? prev : { ...prev, data }
      })
    }

    const channel = supabase
      // Canal por ámbito, p. ej. `tasks:${projectId}`.
      .channel(freeTopic(baseTopic), {
        // SUBSCRIBED solo cuando el stream de postgres_changes ya está activo.
        config: { postgres_changes_options: { wait: true } },
      })
      .on<T>(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table,
          // p. ej. `project_id=eq.${projectId}`
          ...(filterColumn !== null && filterValue !== null
            ? { filter: `${filterColumn}=eq.${filterValue}` }
            : {}),
        },
        handleChange,
      )

    if (filterColumn !== null) {
      // Los DELETE no se pueden filtrar por columnas que no sean la PK (con
      // RLS, payload.old solo trae el id), así que se escuchan sin filtro.
      // Es seguro: applyRealtimeChange ignora ids que no están en la lista.
      channel.on<T>('postgres_changes', { event: 'DELETE', schema: 'public', table }, handleChange)
    }

    channel.subscribe((status) => {
      if (!isCurrent()) return
      if (status === 'SUBSCRIBED') {
        setRealtime('live')
        // PROBLEMA 4 · RECONEXIÓN
        // Los eventos emitidos mientras el canal estaba caído (o entre el fetch
        // inicial y la suscripción) se pierden: Realtime no los reenvía. Cada
        // vez que el canal (re)queda suscrito se vuelve a pedir la lista.
        // La recarga es silenciosa: el usuario no ve el skeleton otra vez.
        void load({ silent: true })
        hasConnected = true
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        // supabase-js reintenta la unión solo; al lograrlo llegará SUBSCRIBED.
        setRealtime(hasConnected ? 'reconnecting' : 'connecting')
      }
    })

    const entry: ChannelEntry = { topic: baseTopic, channel, disposeTimer: null }
    channelRef.current = entry

    return () => scheduleClose(entry)
  }, [table, filterColumn, filterValue, enabled, load, scheduleClose])

  /* ------------------- Recuperación al volver el foco -------------------- */
  // PROBLEMA 4 (bis): con la pestaña en segundo plano el navegador puede
  // congelar el WebSocket; un corte de red también. Al volver el foco o la
  // conexión se recarga, con un intervalo mínimo para no duplicar peticiones.
  useEffect(() => {
    if (!enabled) return
    const resync = (): void => {
      if (document.visibilityState !== 'visible') return
      if (Date.now() - lastLoadAtRef.current < FOCUS_REFETCH_MIN_INTERVAL_MS) return
      void load({ silent: true })
    }
    const onOnline = (): void => void load({ silent: true })
    const onOffline = (): void => setRealtime((current) => (current === 'live' ? 'reconnecting' : current))
    document.addEventListener('visibilitychange', resync)
    window.addEventListener('focus', resync)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => {
      document.removeEventListener('visibilitychange', resync)
      window.removeEventListener('focus', resync)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [enabled, load])

  return { ...state, refetch: load, mutate, realtime }
}
