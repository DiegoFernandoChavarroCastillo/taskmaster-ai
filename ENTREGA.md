# TaskMaster AI · Entrega: capa de persistencia con custom hooks y Supabase Realtime

Stack: React 18 · TypeScript estricto · Vite · Tailwind CSS v4 · Supabase (`@supabase/supabase-js` v2).

Arquitectura en tres capas, sin llamadas a Supabase fuera de `src/hooks/` y `src/lib/`:

| Capa | Archivo | Responsabilidad |
|---|---|---|
| Cliente | `src/lib/supabase.ts` | Cliente único tipado con `Database` (`src/lib/database.types.ts`) |
| Genérico | `src/hooks/useRealtimeList.ts` | Fetch inicial, estado (unión discriminada), suscripción `postgres_changes`, ciclo de vida |
| Dominio | `src/hooks/useTasks.ts`, `useComments.ts`, `useProjectMembers.ts`, `useProjects.ts` | Qué tabla/filtro escuchar, orden y mutaciones |
| UI | `src/components/*.tsx` | Solo renderizan lo que devuelven los hooks |

Esquema SQL: `supabase/migrations/0001_taskmaster.sql`.

---

## 1. `src/hooks/useTasks.ts` (código completo)

```ts
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
  // El error de una mutación pertenece al proyecto en el que ocurrió: se
  // guarda etiquetado y se descarta al cambiar de proyecto (derivado en render).
  const [mutationError, setMutationError] = useState<{ projectId: string; message: string } | null>(null)

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

  /** Envuelve una mutación: contador isMutating + error traducido. */
  const track = useCallback(async <R,>(operation: () => Promise<MutationResult<R>>) => {
    const scope = projectIdRef.current
    setPendingCount((count) => count + 1)
    setMutationError(null)
    try {
      const result = await operation()
      if (!result.ok && isMountedRef.current) setMutationError({ projectId: scope, message: result.error })
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
    error: (mutationError?.projectId === projectId ? mutationError.message : null) ?? list.error,
    createTask,
    updateTask,
    deleteTask,
    isMutating: pendingCount > 0,
    realtime: list.realtime,
    refetch: refetchVisible,
  }
}
```

---

## 2. Consumo del hook en `TaskBoard.tsx` (fragmento)

```tsx
// src/components/TaskBoard.tsx (líneas 25-44 y 106-142, extracto)
export function TaskBoard({ projectId, projectName }: TaskBoardProps) {
  const { tasks, status, error, createTask, updateTask, deleteTask, isMutating, realtime } =
    useTasks(projectId)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const result = await createTask({ title, description, priority })
    if (result.ok) setTitle('') // MutationResult: unión discriminada por `ok`
  }

  const isInitialLoading = status === 'loading' && tasks.length === 0
  return (
    <section aria-labelledby="board-title">
      {/* … cabecera con indicador `realtime` y formulario (botón disabled={isMutating}) … */}
      <div aria-live="assertive" role="status">{error && <p>{error}</p>}</div>
      {isInitialLoading ? <BoardSkeleton /> : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {TASK_STATUSES.map((column) => (
            <section key={column}>
              {tasks.filter((t) => t.status === column).map((task) => (
                <TaskCard key={task.id} task={task} disabled={isMutating}
                  onUpdate={(patch) => void updateTask(task.id, patch)}
                  onDelete={() => void deleteTask(task.id)} />
              ))}
            </section>
          ))}
        </div>
      )}
    </section>
  )
}
```

`TaskBoard.tsx` no importa nada de Supabase: `grep -rn "supabase" src/components/` no devuelve resultados.

---

## 3. Memoria Técnica

La persistencia se organiza en tres capas. `lib/supabase.ts` expone un cliente único tipado con el esquema, y TypeScript valida cada consulta. `hooks/useRealtimeList.ts` es un hook genérico que encapsula fetch inicial, estado como unión discriminada y suscripción a `postgres_changes`; no conoce tareas, solo filas identificables por id. Sobre él, `useTasks` declara qué tabla escucha, con qué filtro y cómo ordena, y añade las mutaciones. `useComments`, `useProjectMembers` y `useProjects` reutilizan el mismo genérico con otras tablas, demostrando que la abstracción es general.

Los componentes nunca importan el cliente: `TaskBoard` recibe datos y funciones del hook y solo renderiza columnas, formulario, skeleton, estado vacío y errores. Así la interfaz cambia sin tocar la persistencia, verificada con tests sin navegador.

La consistencia en tiempo real se garantiza con cuatro reglas. Primera, deduplicación: el autor de un insert recibe también su propio evento, por lo que cada INSERT se descarta si su id ya existe en memoria. Segunda, el handler se registra una sola vez y nunca lee estado capturado; usa `setState` funcional y una ref con las opciones vigentes. Tercera, orden: un UPDATE solo se aplica si su `updated_at`, fijado por un trigger del servidor, es más reciente que el de la fila local. Cuarta, recuperación: cada vez que el canal vuelve a quedar suscrito, la pestaña recupera el foco o regresa la red, se recarga la lista en silencio, porque Realtime no reenvía eventos perdidos.

Las mutaciones son optimistas. El insert usa un id temporal que se reconcilia con la fila devuelta por `.select().single()`; si Supabase falla, se restaura el snapshot de esa fila, no la lista entera, para no deshacer cambios ajenos, y se muestra el error traducido. La limpieza llama a `removeChannel`, el canal vive en una ref protegida contra el doble montaje de StrictMode y un AbortController descarta respuestas tardías.

---

## 4. Rúbrica: dónde se evidencia cada criterio

| Criterio | Archivo | Líneas | Evidencia |
|---|---|---|---|
| **Abstracción y modularidad** | `src/hooks/useRealtimeList.ts` · `src/hooks/useTasks.ts` · `src/hooks/useComments.ts` · `src/hooks/useProjectMembers.ts` · `src/lib/supabase.ts` · `src/components/TaskBoard.tsx` | useRealtimeList 14-62 (tipos y `ListState` como unión discriminada), 198 (genérico `<T extends Row>`); useTasks 62-75 (configuración del genérico), 25-36 (contrato público); useComments 23; useProjectMembers 34-50 (estrategia `refetch`); supabase.ts 21; TaskBoard 26-28 (solo consume hooks) | Un único hook genérico reutilizado por cuatro hooks de dominio; los componentes no conocen el cliente |
| **Ejecución técnica Supabase/React** | `supabase/migrations/0001_taskmaster.sql` · `src/hooks/useRealtimeList.ts` · `src/hooks/useTasks.ts` | SQL 69 (índice `(project_id, created_at)`), 153-260 (funciones SECURITY DEFINER con `search_path = ''`), 267-359 (RLS por pertenencia), 363 y 381 (publicación y REPLICA IDENTITY FULL); useRealtimeList 99-131 (problemas 1 y 3: deduplicación y orden), 335-352 (problema 2: setState funcional), 356-379 (canal `tasks:${projectId}` y filtro `project_id=eq.${projectId}`), 381-396 y 404-427 (problema 4: reconexión y foco); useTasks 115-181 (insert optimista con id temporal y reconciliación), 183-234 (update con rollback por fila), 236-271 (delete con rollback) | Esquema con RLS sin recursión, Realtime coherente ante duplicados, desorden y cortes, mutaciones optimistas con rollback |
| **Manejo de ciclo de vida** | `src/hooks/useRealtimeList.ts` · `src/hooks/useTasks.ts` · `src/hooks/realtime.test.tsx` | useRealtimeList 207-215 (reinicio de estado al cambiar de proyecto), 232-248 (canal en `useRef` y `removeChannel`), 250-281 (AbortController: sin setState tras desmontar), 289-301 (abort en la limpieza del fetch), 309-320 (guard de StrictMode), 322-326 (cierre del canal anterior antes de abrir el nuevo), 401 (función de limpieza); useTasks 92-99 (`isMountedRef`); tests 151-214 (StrictMode, limpieza, cambio de proyecto, abort) | Sin canales huérfanos ni suscripciones dobles, verificado con 11 tests automatizados |

---

## 5. Repositorio

https://github.com/DiegoFernandoChavarroCastillo/taskmaster-ai

---

## Verificación realizada

| Comprobación | Resultado |
|---|---|
| `npm run build` (`tsc -b && vite build`) | Sin errores ni warnings de TypeScript |
| `npm run lint` (oxlint) | 0 warnings, 0 errores |
| `npm test` (Vitest, cliente Supabase simulado) | 11/11 tests en verde |
| `grep -rn ": any\|as any" src/` | Sin resultados |
| `grep -rn "supabase" src/components/` | Sin resultados |
| `.env.local` versionado | No (ignorado por `.gitignore`; solo se versiona `.env.example`) |
| Palabras de la Memoria Técnica (`wc -w`) | 300 |
