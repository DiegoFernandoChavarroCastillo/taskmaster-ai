import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Task, TaskPriority, TaskStatus } from '../lib/database.types'
import { translateError } from '../lib/errors'
import { supabase } from '../lib/supabase'
import { byCreatedAt, compareTimestamps } from '../lib/timestamps'
import { upsertById, useRealtimeList, type ListStatus, type RealtimeStatus } from './useRealtimeList'

/* -------------------------------------------------------------------------- */
/* Tipos públicos                                                             */
/* -------------------------------------------------------------------------- */

export interface NewTaskInput {
  title: string
  description?: string | null
  status?: TaskStatus
  priority?: TaskPriority
  assignee_id?: string | null
}

export type TaskPatch = Partial<Pick<Task, 'title' | 'description' | 'status' | 'priority' | 'assignee_id'>>

/** Resultado de una mutación: unión discriminada por `ok`. */
export type MutationResult<T> = { ok: true; data: T } | { ok: false; error: string }

export interface UseTasksResult {
  tasks: readonly Task[]
  status: ListStatus
  error: string | null
  createTask: (input: NewTaskInput) => Promise<MutationResult<Task>>
  updateTask: (id: string, patch: TaskPatch) => Promise<MutationResult<Task>>
  deleteTask: (id: string) => Promise<MutationResult<{ id: string }>>
  isMutating: boolean
  /** Estado del canal `tasks:${projectId}` (indicador "en vivo"). */
  realtime: RealtimeStatus
  refetch: () => Promise<void>
}

/* -------------------------------------------------------------------------- */
/* Reglas de orden                                                            */
/* -------------------------------------------------------------------------- */

/** Orden de eventos: solo gana una versión estrictamente más reciente. */
const isNewerTask = (incoming: Task, current: Task): boolean =>
  compareTimestamps(incoming.updated_at, current.updated_at) > 0

/** La respuesta de nuestra propia mutación sustituye a la fila si no es más antigua. */
const isSameOrNewerTask = (incoming: Task, current: Task): boolean =>
  compareTimestamps(incoming.updated_at, current.updated_at) >= 0

/* -------------------------------------------------------------------------- */
/* Hook                                                                       */
/* -------------------------------------------------------------------------- */

export function useTasks(projectId: string): UseTasksResult {
  // Toda la lógica de Realtime vive en el hook genérico (hooks/useRealtimeList.ts):
  //  - canal `tasks:${projectId}` con postgres_changes filtrado por
  //    `project_id=eq.${projectId}`, cerrado con removeChannel al desmontar o
  //    cambiar de proyecto y protegido contra el doble montaje de StrictMode;
  //  - deduplicación por id, handler sin cierres obsoletos (setState
  //    funcional), orden por updated_at (isNewer) y refetch tras reconexión.
  // Aquí solo se declara QUÉ se escucha y CÓMO se ordena.
  const list = useRealtimeList<Task>({
    table: 'tasks',
    filter: { column: 'project_id', value: projectId },
    enabled: projectId !== '',
    query: (signal) =>
      supabase
        .from('tasks')
        .select('*')
        .eq('project_id', projectId)
        .order('created_at', { ascending: true })
        .abortSignal(signal),
    sort: byCreatedAt,
    isNewer: isNewerTask,
  })
  const { data: tasks, mutate, refetch } = list

  const [pendingCount, setPendingCount] = useState(0)
  const [mutationError, setMutationError] = useState<string | null>(null)

  // Las mutaciones son asíncronas: al resolver deben leer la lista y el
  // proyecto ACTUALES, no los capturados por el closure cuando empezaron.
  const tasksRef = useRef(tasks)
  const projectIdRef = useRef(projectId)
  useLayoutEffect(() => {
    tasksRef.current = tasks
    projectIdRef.current = projectId
  })

  // Evita setState tras el desmontaje si una mutación resuelve tarde.
  const isMountedRef = useRef(false)
  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  // El error de una mutación pertenece al proyecto en el que ocurrió.
  useEffect(() => {
    setMutationError(null)
  }, [projectId])

  /** Envuelve una mutación: contador isMutating + error traducido. */
  const track = useCallback(async <R,>(operation: () => Promise<MutationResult<R>>) => {
    setPendingCount((count) => count + 1)
    setMutationError(null)
    try {
      const result = await operation()
      if (!result.ok && isMountedRef.current) setMutationError(result.error)
      return result
    } finally {
      if (isMountedRef.current) setPendingCount((count) => count - 1)
    }
  }, [])

  /* ------------------------------- CREATE -------------------------------- */
  const createTask = useCallback(
    (input: NewTaskInput) =>
      track<Task>(async () => {
        const title = input.title.trim()
        if (!title) return { ok: false, error: 'El título de la tarea es obligatorio.' }

        const scope = projectId
        const tempId = crypto.randomUUID()
        const now = new Date().toISOString()
        const optimistic: Task = {
          id: tempId,
          project_id: scope,
          title,
          description: input.description?.trim() || null,
          status: input.status ?? 'pendiente',
          priority: input.priority ?? 'media',
          assignee_id: input.assignee_id ?? null,
          created_at: now,
          updated_at: now,
        }

        // 1) Optimista: la tarea aparece al instante con un id temporal.
        mutate((rows) => [...rows, optimistic])

        // 2) Petición real. .select().single() devuelve la fila con el id,
        //    created_at y updated_at definitivos generados por Postgres.
        const { data, error } = await supabase
          .from('tasks')
          .insert({
            project_id: scope,
            title: optimistic.title,
            description: optimistic.description,
            status: optimistic.status,
            priority: optimistic.priority,
            assignee_id: optimistic.assignee_id,
          })
          .select()
          .single()

        // Si el usuario cambió de proyecto mientras tanto, no se toca la
        // lista nueva con datos del proyecto anterior.
        const sameScope = projectIdRef.current === scope

        if (error || !data) {
          // 3a) Rollback: se retira la fila temporal.
          if (sameScope) mutate((rows) => rows.filter((row) => row.id !== tempId))
          return { ok: false, error: translateError(error) }
        }

        // 3b) Reconciliación: se sustituye el id temporal por la fila real.
        //     El evento INSERT de Realtime puede haber llegado ANTES que esta
        //     respuesta; por eso no basta con reemplazar el temporal: se quita
        //     y se hace upsert por id, evitando la fila duplicada.
        if (sameScope) {
          mutate((rows) =>
            upsertById(
              rows.filter((row) => row.id !== tempId),
              data,
              { isNewer: isSameOrNewerTask },
            ),
          )
        }
        return { ok: true, data }
      }),
    [projectId, mutate, track],
  )

  /* ------------------------------- UPDATE -------------------------------- */
  const updateTask = useCallback(
    (id: string, patch: TaskPatch) =>
      track<Task>(async () => {
        const scope = projectId
        // Snapshot de la fila antes del cambio (para el rollback).
        const previous = tasksRef.current.find((row) => row.id === id)
        if (!previous) return { ok: false, error: 'La tarea ya no existe.' }
        if (patch.title !== undefined && !patch.title.trim()) {
          return { ok: false, error: 'El título de la tarea es obligatorio.' }
        }

        // 1) Optimista. NO se toca updated_at: lo fija el trigger del servidor
        //    y es la referencia para ordenar eventos (ver isNewerTask).
        mutate((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)))

        const { data, error } = await supabase
          .from('tasks')
          .update(patch)
          .eq('id', id)
          .select()
          .single()

        const sameScope = projectIdRef.current === scope

        if (error || !data) {
          // 2a) Rollback al snapshot, fila a fila y solo si nadie la ha
          //     cambiado desde entonces (mismo updated_at). Restaurar la lista
          //     entera desharía eventos Realtime legítimos de otros usuarios.
          if (sameScope) {
            mutate((rows) =>
              rows.map((row) =>
                row.id === id && row.updated_at === previous.updated_at ? previous : row,
              ),
            )
          }
          // PGRST116 = 0 filas: la borró otro usuario o perdimos acceso.
          if (error?.code === 'PGRST116') void refetch({ silent: true })
          return { ok: false, error: translateError(error) }
        }

        // 2b) Reconciliación con la versión del servidor (updated_at real).
        //     Solo reemplaza: si la fila desapareció (DELETE remoto), no se resucita.
        if (sameScope) {
          mutate((rows) =>
            rows.map((row) => (row.id === data.id && isSameOrNewerTask(data, row) ? data : row)),
          )
        }
        return { ok: true, data }
      }),
    [projectId, mutate, refetch, track],
  )

  /* ------------------------------- DELETE -------------------------------- */
  const deleteTask = useCallback(
    (id: string) =>
      track<{ id: string }>(async () => {
        const scope = projectId
        const previous = tasksRef.current.find((row) => row.id === id)
        if (!previous) return { ok: false, error: 'La tarea ya no existe.' }

        // 1) Optimista: desaparece al instante.
        mutate((rows) => rows.filter((row) => row.id !== id))

        // .select('id') permite distinguir "borrada" de "0 filas afectadas"
        // (RLS no lanza error al borrar algo invisible: simplemente no borra).
        const { data, error } = await supabase.from('tasks').delete().eq('id', id).select('id')

        const sameScope = projectIdRef.current === scope

        if (error) {
          // 2a) Rollback: se restaura el snapshot si no ha vuelto ya por otra vía.
          if (sameScope) {
            mutate((rows) => (rows.some((row) => row.id === id) ? rows : [...rows, previous]))
          }
          return { ok: false, error: translateError(error) }
        }

        if (data.length === 0) {
          // 2b) Nada que restaurar: la tarea ya no existe en el servidor (o no
          //     hay permiso). Se resincroniza con la fuente de verdad.
          if (sameScope) void refetch({ silent: true })
          return { ok: false, error: 'La tarea ya no existe o no tienes permisos para borrarla.' }
        }

        return { ok: true, data: { id } }
      }),
    [projectId, mutate, refetch, track],
  )

  const refetchVisible = useCallback(() => refetch(), [refetch])

  return {
    tasks,
    status: list.status,
    error: mutationError ?? list.error,
    createTask,
    updateTask,
    deleteTask,
    isMutating: pendingCount > 0,
    realtime: list.realtime,
    refetch: refetchVisible,
  }
}
