import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { TableName } from '../lib/database.types'
import { isAbortError, translateError } from '../lib/errors'

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
  /** false desactiva fetch y suscripción (p. ej. sin projectId). */
  enabled?: boolean
}

export type Updater<T> = (rows: readonly T[]) => readonly T[]

export type RealtimeList<T> = ListState<T> & {
  /** Vuelve a pedir la lista. `silent` mantiene los datos visibles (sin skeleton). */
  refetch: (options?: { silent?: boolean }) => Promise<void>
  /** Parche local (actualizaciones optimistas). Usa siempre la forma funcional. */
  mutate: (updater: Updater<T>) => void
}

/* -------------------------------------------------------------------------- */
/* Utilidades puras                                                           */
/* -------------------------------------------------------------------------- */

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
  options: { isNewer?: (incoming: T, current: T) => boolean; sort?: (a: T, b: T) => number } = {},
): readonly T[] {
  const index = rows.findIndex((row) => row.id === incoming.id)
  if (index === -1) return sortRows([...rows, incoming], options.sort)
  const current = rows[index]
  if (current && options.isNewer && !options.isNewer(incoming, current)) return rows
  return sortRows(rows.with(index, incoming), options.sort)
}

/**
 * Combina la instantánea del servidor con lo que hay en memoria: manda el
 * servidor, salvo que en memoria exista una versión más reciente de la misma
 * fila (llegó por otra vía mientras la petición viajaba).
 */
function mergeSnapshot<T extends Row>(
  local: readonly T[],
  server: readonly T[],
  isNewer?: (incoming: T, current: T) => boolean,
  sort?: (a: T, b: T) => number,
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
/* Hook                                                                       */
/* -------------------------------------------------------------------------- */

const INITIAL: ListState<never> = { status: 'idle', data: [], error: null }

/**
 * Hook genérico: fetch inicial + estado de la lista.
 * Ningún componente necesita conocer supabase-js: solo consumen este hook
 * a través de hooks de dominio (useTasks, useComments, useProjectMembers).
 */
export function useRealtimeList<T extends Row>(options: RealtimeListOptions<T>): RealtimeList<T> {
  const { table, filter, enabled = true } = options
  const filterColumn = filter?.column ?? null
  const filterValue = filter?.value ?? null

  const [state, setState] = useState<ListState<T>>(INITIAL)

  // Las opciones (query, sort, isNewer) suelen ser closures nuevas en cada
  // render. Se guardan en una ref para leer siempre la última versión sin
  // tener que reiniciar efectos ni suscripciones.
  const optionsRef = useRef(options)
  useLayoutEffect(() => {
    optionsRef.current = options
  })

  // Controlador de la petición en curso: permite cancelarla al desmontar,
  // al cambiar de ámbito o cuando una petición más nueva la reemplaza.
  const abortRef = useRef<AbortController | null>(null)

  const load = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
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
        data: mergeSnapshot(prev.data, data ?? [], isNewer, sort),
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

  // Fetch inicial. Se repite cuando cambia el ámbito (tabla / filtro).
  useEffect(() => {
    if (!enabled) {
      setState(INITIAL)
      return
    }
    // Ámbito nuevo: se vacía la lista para no mostrar datos del proyecto anterior.
    setState({ status: 'loading', data: [], error: null })
    void load({ silent: true })
    return () => {
      abortRef.current?.abort()
      abortRef.current = null
    }
  }, [table, filterColumn, filterValue, enabled, load])

  return { ...state, refetch: load, mutate }
}
