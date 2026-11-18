/**
 * Verificación del contrato de tiempo real y de ciclo de vida con un cliente
 * Supabase simulado (sin red): StrictMode, limpieza, cambio de proyecto,
 * deduplicación, orden por updated_at, reconexión y rollback optimista.
 */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { StrictMode, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Task } from '../lib/database.types'

/* ------------------------------ Fake client ------------------------------ */

type Payload = Record<string, unknown>
type Listener = { filter: Record<string, unknown>; callback: (payload: Payload) => void }

interface FakeChannel {
  topic: string
  listeners: Listener[]
  statusCallback: ((status: string) => void) | null
  removed: boolean
  on: (type: string, filter: Record<string, unknown>, callback: (payload: Payload) => void) => FakeChannel
  subscribe: (callback: (status: string) => void) => FakeChannel
}

type DbResult = { data: unknown; error: { code?: string; message: string } | null }

const fake = vi.hoisted(() => {
  const state = {
    log: [] as string[],
    channels: [] as FakeChannel[],
    /** Respuestas en cola para insert/update/delete (en orden). */
    mutationResults: [] as Array<() => Promise<DbResult>>,
    tasksSnapshot: [] as unknown[],
  }

  const makeChannel = (topic: string): FakeChannel => {
    const channel: FakeChannel = {
      topic: `realtime:${topic}`,
      listeners: [],
      statusCallback: null,
      removed: false,
      on(_type, filter, callback) {
        if (channel.statusCallback) throw new Error('cannot add postgres_changes callbacks after subscribe()')
        channel.listeners.push({ filter, callback })
        return channel
      },
      subscribe(callback) {
        channel.statusCallback = callback
        return channel
      },
    }
    return channel
  }

  const thenable = (result: () => Promise<DbResult>) => {
    const builder: Record<string, unknown> = {}
    for (const method of ['select', 'eq', 'order', 'abortSignal', 'single', 'insert', 'update', 'delete']) {
      builder[method] = () => builder
    }
    builder.then = (resolve: (value: DbResult) => unknown, reject: (reason: unknown) => unknown) =>
      result().then(resolve, reject)
    return builder
  }

  const supabase = {
    channel(topic: string) {
      const existing = state.channels.find((c) => c.topic === `realtime:${topic}` && !c.removed)
      if (existing) return existing
      state.log.push(`open ${topic}`)
      const channel = makeChannel(topic)
      state.channels.push(channel)
      return channel
    },
    async removeChannel(channel: FakeChannel) {
      state.log.push(`close ${channel.topic.replace('realtime:', '')}`)
      await Promise.resolve()
      channel.removed = true
      return 'ok'
    },
    getChannels() {
      return state.channels.filter((c) => !c.removed)
    },
    from(_table: string) {
      const next = (fallback: DbResult) => state.mutationResults.shift() ?? (async () => fallback)
      return {
        select: () => thenable(async () => ({ data: [...state.tasksSnapshot], error: null })),
        insert: () => thenable(next({ data: null, error: null })),
        update: () => thenable(next({ data: null, error: null })),
        delete: () => thenable(next({ data: [], error: null })),
      }
    },
    auth: { getSession: async () => ({ data: { session: null } }) },
  }
  return { state, supabase }
})

vi.mock('../lib/supabase', () => ({ supabase: fake.supabase }))

// Importados después del mock.
const { useRealtimeList } = await import('./useRealtimeList')
const { useTasks } = await import('./useTasks')

/* -------------------------------- Helpers -------------------------------- */

const strict = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>
const tick = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 5)))
const live = () => fake.state.channels.filter((c) => !c.removed)

function task(id: string, updatedAt: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    project_id: 'p1',
    title: `Tarea ${id}`,
    description: null,
    status: 'pendiente',
    priority: 'media',
    assignee_id: null,
    created_at: '2026-11-18T10:00:00.000000+00:00',
    updated_at: updatedAt,
    ...extra,
  }
}

function emit(channel: FakeChannel | undefined, payload: Payload) {
  if (!channel) throw new Error('canal inexistente')
  act(() => {
    for (const listener of channel.listeners) {
      const event = listener.filter.event
      if (event === '*' || event === payload.eventType) listener.callback(payload)
    }
  })
}

const T0 = '2026-11-18T10:00:00.000000+00:00'
const T1 = '2026-11-18T10:00:00.000500+00:00' // mismo ms que T0, +500 µs
const T2 = '2026-11-18T10:00:01.000000+00:00'

beforeEach(() => {
  fake.state.log = []
  fake.state.channels = []
  fake.state.mutationResults = []
  fake.state.tasksSnapshot = []
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/* --------------------------------- Tests --------------------------------- */

describe('useRealtimeList · ciclo de vida', () => {
  type Query = (signal: AbortSignal) => Promise<{ data: Task[]; error: null }>
  const defaultQuery: Query = async () => ({ data: [task('a', T0)], error: null })
  const options = (value: string, query: Query = defaultQuery) => ({
    table: 'tasks' as const,
    filter: { column: 'project_id', value },
    query,
    isNewer: (a: Task, b: Task) => a.updated_at > b.updated_at,
  })

  it('StrictMode: una sola suscripción activa y un solo canal abierto', async () => {
    renderHook(() => useRealtimeList<Task>(options('p1')), { wrapper: strict })
    await tick()
    expect(live()).toHaveLength(1)
    expect(fake.state.log.filter((l) => l.startsWith('open'))).toEqual(['open tasks:p1'])
    // Un listener filtrado (*) + uno de DELETE sin filtro, registrados una vez.
    expect(live()[0]?.listeners).toHaveLength(2)
    expect(live()[0]?.listeners[0]?.filter).toMatchObject({ event: '*', filter: 'project_id=eq.p1' })
  })

  it('desmontar llama a removeChannel y no deja canales huérfanos', async () => {
    const { unmount } = renderHook(() => useRealtimeList<Task>(options('p1')), { wrapper: strict })
    await tick()
    unmount()
    await tick()
    expect(fake.state.log).toContain('close tasks:p1')
    expect(live()).toHaveLength(0)
  })

  it('cambiar de proyecto cierra el canal anterior ANTES de abrir el nuevo', async () => {
    const { rerender } = renderHook(({ id }) => useRealtimeList<Task>(options(id)), {
      wrapper: strict,
      initialProps: { id: 'p1' },
    })
    await tick()
    rerender({ id: 'p2' })
    await tick()
    const closeP1 = fake.state.log.indexOf('close tasks:p1')
    const openP2 = fake.state.log.indexOf('open tasks:p2')
    expect(closeP1).toBeGreaterThan(-1)
    expect(closeP1).toBeLessThan(openP2)
    expect(live().map((c) => c.topic)).toEqual(['realtime:tasks:p2'])
  })

  it('no hace setState si la petición inicial resuelve tras desmontar (abort)', async () => {
    let seenSignal: AbortSignal | null = null
    let resolveQuery: (value: { data: Task[]; error: null }) => void = () => {}
    const query = vi.fn(
      (signal: AbortSignal) =>
        new Promise<{ data: Task[]; error: null }>((resolve) => {
          seenSignal = signal
          resolveQuery = resolve
        }),
    )
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { result, unmount } = renderHook(() => useRealtimeList<Task>(options('p1', query)))
    expect(result.current.status).toBe('loading')
    unmount()
    expect(seenSignal).not.toBeNull()
    expect((seenSignal as AbortSignal | null)?.aborted).toBe(true)
    await act(async () => resolveQuery({ data: [task('late', T0)], error: null }))
    expect(errors).not.toHaveBeenCalled()
  })
})

describe('useRealtimeList · consistencia', () => {
  async function setup() {
    const query = vi.fn(async () => ({ data: [task('a', T0)], error: null }))
    const hook = renderHook(() =>
      useRealtimeList<Task>({
        table: 'tasks',
        filter: { column: 'project_id', value: 'p1' },
        query,
        isNewer: (incoming, current) => incoming.updated_at > current.updated_at,
      }),
    )
    await waitFor(() => expect(hook.result.current.status).toBe('success'))
    return { ...hook, query, channel: live()[0] }
  }

  it('1) deduplica el INSERT propio comparando por id', async () => {
    const { result, channel } = await setup()
    emit(channel, { eventType: 'INSERT', new: task('a', T0), old: {} })
    expect(result.current.data).toHaveLength(1)
    emit(channel, { eventType: 'INSERT', new: task('b', T0), old: {} })
    expect(result.current.data.map((t) => t.id)).toEqual(['a', 'b'])
  })

  it('2+3) aplica UPDATE solo si updated_at es más reciente (handler sin cierres obsoletos)', async () => {
    const { result, channel } = await setup()
    emit(channel, { eventType: 'UPDATE', new: task('a', T2, { title: 'nuevo' }), old: {} })
    expect(result.current.data[0]?.title).toBe('nuevo')
    // Evento tardío con un updated_at anterior: no pisa el cambio más nuevo.
    emit(channel, { eventType: 'UPDATE', new: task('a', T1, { title: 'viejo' }), old: {} })
    expect(result.current.data[0]?.title).toBe('nuevo')
  })

  it('DELETE con payload.old reducido a la PK elimina por id', async () => {
    const { result, channel } = await setup()
    emit(channel, { eventType: 'DELETE', new: {}, old: { id: 'a' } })
    expect(result.current.data).toHaveLength(0)
    emit(channel, { eventType: 'DELETE', new: {}, old: { id: 'otro-proyecto' } })
    expect(result.current.data).toHaveLength(0)
  })

  it('4) vuelve a hacer fetch cada vez que el canal (re)queda SUBSCRIBED', async () => {
    const { query, channel, result } = await setup()
    const before = query.mock.calls.length
    act(() => channel?.statusCallback?.('SUBSCRIBED'))
    act(() => channel?.statusCallback?.('CHANNEL_ERROR'))
    expect(result.current.realtime).toBe('reconnecting')
    act(() => channel?.statusCallback?.('SUBSCRIBED'))
    await waitFor(() => expect(query.mock.calls.length).toBe(before + 2))
    expect(result.current.realtime).toBe('live')
  })
})

describe('useTasks · mutaciones optimistas', () => {
  it('create: id temporal → fila real, sin duplicar si el INSERT de Realtime llega antes', async () => {
    fake.state.tasksSnapshot = []
    const real = task('real-id', T0, { title: 'Escribir memoria' })
    let resolveInsert: (value: DbResult) => void = () => {}
    fake.state.mutationResults.push(() => new Promise<DbResult>((resolve) => (resolveInsert = resolve)))

    const { result } = renderHook(() => useTasks('p1'))
    await waitFor(() => expect(result.current.status).toBe('success'))
    const channel = live()[0]

    let pending: Promise<unknown> = Promise.resolve()
    act(() => {
      pending = result.current.createTask({ title: 'Escribir memoria' })
    })
    // Optimista: aparece al instante con un id temporal.
    expect(result.current.tasks).toHaveLength(1)
    expect(result.current.tasks[0]?.id).not.toBe('real-id')
    expect(result.current.isMutating).toBe(true)

    await tick() // deja que la petición insert llegue al cliente simulado
    expect(result.current.tasks).toHaveLength(1)
    // El evento INSERT propio llega antes que la respuesta de .select().single().
    emit(channel, { eventType: 'INSERT', new: real, old: {} })
    await act(async () => {
      resolveInsert({ data: real, error: null })
      await pending
    })
    expect(result.current.tasks.map((t) => t.id)).toEqual(['real-id'])
    expect(result.current.isMutating).toBe(false)
  })

  it('update: si el servidor falla, revierte al snapshot y traduce el error', async () => {
    fake.state.tasksSnapshot = [task('a', T0, { status: 'pendiente' })]
    fake.state.mutationResults.push(async () => ({
      data: null,
      error: { code: '42501', message: 'new row violates row-level security policy' },
    }))
    const { result } = renderHook(() => useTasks('p1'))
    await waitFor(() => expect(result.current.tasks).toHaveLength(1))

    await act(async () => {
      const outcome = await result.current.updateTask('a', { status: 'hecha' })
      expect(outcome.ok).toBe(false)
    })
    expect(result.current.tasks[0]?.status).toBe('pendiente')
    expect(result.current.error).toBe('No tienes permisos para realizar esta acción en el proyecto.')
  })

  it('delete: optimista y rollback si falla la red', async () => {
    fake.state.tasksSnapshot = [task('a', T0)]
    fake.state.mutationResults.push(async () => ({ data: null, error: { message: 'TypeError: Failed to fetch' } }))
    const { result } = renderHook(() => useTasks('p1'))
    await waitFor(() => expect(result.current.tasks).toHaveLength(1))
    await act(async () => {
      await result.current.deleteTask('a')
    })
    expect(result.current.tasks.map((t) => t.id)).toEqual(['a'])
    expect(result.current.error).toMatch(/Sin conexión/)
  })
})
