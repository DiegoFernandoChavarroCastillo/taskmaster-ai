# TaskMaster AI · Persistencia con Custom Hooks y Supabase Realtime

**Repositorio:** https://github.com/DiegoFernandoChavarroCastillo/taskmaster-ai
**Stack:** React 18 · TypeScript estricto (sin `any`) · Vite · Tailwind v4 · Supabase

## Arquitectura

| Capa | Archivo | Responsabilidad |
|---|---|---|
| Cliente | `lib/supabase.ts` | Cliente único tipado con el esquema |
| Genérico | `hooks/useRealtimeList.ts` | Fetch, estado `loading/error/data`, suscripción y limpieza |
| Dominio | `hooks/useTasks.ts` (+ `useComments`, `useProjectMembers`) | Qué escuchar y mutaciones optimistas |
| UI | `components/TaskBoard.tsx` | Solo renderiza; no importa Supabase |

Entidades: tareas (`useTasks`), usuarios (`useProjectMembers`), comentarios (`useComments`). Las tres reutilizan el mismo hook genérico.

## 1. Custom Hook principal: `useTasks.ts`

Extracto condensado (el objeto optimista se resume en `toOptimisticTask`). El código completo está en [useTasks.ts](https://github.com/DiegoFernandoChavarroCastillo/taskmaster-ai/blob/main/src/hooks/useTasks.ts).

```ts
export function useTasks(projectId: string): UseTasksResult {
  // Fetching filtrado por proyecto + suscripción del canal `tasks:${projectId}`
  const list = useRealtimeList<Task>({
    table: 'tasks',
    filter: { column: 'project_id', value: projectId },
    enabled: projectId !== '',
    query: (signal) => supabase.from('tasks').select('*')
      .eq('project_id', projectId).order('created_at').abortSignal(signal),
    sort: byCreatedAt,
    isNewer: (a, b) => compareTimestamps(a.updated_at, b.updated_at) > 0,
  })
  const { data: tasks, mutate } = list

  const createTask = useCallback((input: NewTaskInput) => track<Task>(async () => {
    const tempId = crypto.randomUUID()
    mutate((rows) => [...rows, toOptimisticTask(tempId, projectId, input)]) // optimista
    const { data, error } = await supabase.from('tasks')
      .insert({ project_id: projectId, title: input.title.trim() }).select().single()
    if (error || !data) {
      mutate((rows) => rows.filter((r) => r.id !== tempId))                // rollback
      return { ok: false, error: translateError(error) }
    }
    mutate((rows) => upsertById(rows.filter((r) => r.id !== tempId), data)) // reconciliar
    return { ok: true, data }
  }), [projectId, mutate, track])

  const updateTask = useCallback((id: string, patch: TaskPatch) => track<Task>(async () => {
    const previous = tasksRef.current.find((r) => r.id === id)                // snapshot
    if (!previous) return { ok: false, error: 'La tarea ya no existe.' }
    mutate((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)))
    const { data, error } = await supabase.from('tasks').update(patch).eq('id', id).select().single()
    if (error || !data) {
      mutate((rows) => rows.map((r) => (r.id === id && r.updated_at === previous.updated_at ? previous : r)))
      return { ok: false, error: translateError(error) }
    }
    mutate((rows) => rows.map((r) => (r.id === id ? data : r)))
    return { ok: true, data }
  }), [mutate, track])

  // deleteTask: mismo patrón (quitar → delete().eq().select('id') → restaurar si falla)

  return { tasks, status: list.status, error: mutationError ?? list.error,
    createTask, updateTask, deleteTask, isMutating: pending > 0, realtime: list.realtime }
}
```

### Suscripción y limpieza: [useRealtimeList.ts](https://github.com/DiegoFernandoChavarroCastillo/taskmaster-ai/blob/main/src/hooks/useRealtimeList.ts#L304-L402)

```ts
useEffect(() => {
  if (!enabled) return
  const topic = `${table}:${filterValue}`
  const prev = channelRef.current
  // StrictMode: si se vuelve a montar con el mismo canal, se reutiliza (no hay doble suscripción)
  if (prev?.topic === topic && prev.disposeTimer !== null) {
    clearTimeout(prev.disposeTimer); prev.disposeTimer = null
    return () => scheduleClose(prev)
  }
  if (prev) closeChannel(prev) // cambio de proyecto: cierra el canal anterior antes de abrir el nuevo

  const handle = (payload: RealtimePostgresChangesPayload<T>) =>
    // setState funcional: el handler se registra una vez y nunca lee estado viejo
    setState((s) => ({ ...s, data: applyRealtimeChange(s.data, payload, optionsRef.current) }))

  const channel = supabase.channel(topic)
    .on<T>('postgres_changes', { event: '*', schema: 'public', table,
      filter: `${filterColumn}=eq.${filterValue}` }, handle)
    .on<T>('postgres_changes', { event: 'DELETE', schema: 'public', table }, handle)
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') void load({ silent: true }) // recupera eventos perdidos al reconectar
    })
  const entry = { topic, channel, disposeTimer: null }
  channelRef.current = entry
  return () => scheduleClose(entry) // → supabase.removeChannel(channel)
}, [table, filterColumn, filterValue, enabled])
```

`applyRealtimeChange` ([L99-131](https://github.com/DiegoFernandoChavarroCastillo/taskmaster-ai/blob/main/src/hooks/useRealtimeList.ts#L99-L131)): descarta un INSERT cuyo id ya está en la lista (deduplicación), aplica un UPDATE solo si su `updated_at` es más reciente y borra en DELETE por id. El fetch usa `AbortController`: al desmontar se cancela la petición y no se hace `setState` ([L250-301](https://github.com/DiegoFernandoChavarroCastillo/taskmaster-ai/blob/main/src/hooks/useRealtimeList.ts#L250-L301)).

**RLS** ([migración](https://github.com/DiegoFernandoChavarroCastillo/taskmaster-ai/blob/main/supabase/migrations/0001_taskmaster.sql)): un usuario solo ve y modifica las tareas de sus proyectos. La función `SECURITY DEFINER` evita la recursión entre políticas.

```sql
create policy "tasks_select_members" on public.tasks for select to authenticated
  using (public.is_project_member(project_id)); -- igual en insert/update/delete
```

## 2. Implementación en un componente

```tsx
export function TaskBoard({ projectId }: { projectId: string }) {
  const { tasks, status, error, createTask, updateTask, deleteTask, isMutating } =
    useTasks(projectId)

  if (status === 'loading' && tasks.length === 0) return <BoardSkeleton />
  return (
    <section>
      <div aria-live="assertive" role="status">{error && <p>{error}</p>}</div>
      <button disabled={isMutating} onClick={() => void createTask({ title: 'Nueva' })}>
        Crear tarea
      </button>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {tasks.map((task) => (
          <TaskCard key={task.id} task={task} disabled={isMutating}
            onUpdate={(patch) => void updateTask(task.id, patch)}
            onDelete={() => void deleteTask(task.id)} />
        ))}
      </div>
    </section>
  )
}
```

## 3. Memoria técnica (300 palabras)

La persistencia se organiza en tres capas. `lib/supabase.ts` expone un cliente único tipado con el esquema, y TypeScript valida cada consulta. `hooks/useRealtimeList.ts` es un hook genérico que encapsula fetch inicial, estado como unión discriminada y suscripción a `postgres_changes`; no conoce tareas, solo filas identificables por id. Sobre él, `useTasks` declara qué tabla escucha, con qué filtro y cómo ordena, y añade las mutaciones. `useComments`, `useProjectMembers` y `useProjects` reutilizan el mismo genérico con otras tablas, demostrando que la abstracción es general.

Los componentes nunca importan el cliente: `TaskBoard` recibe datos y funciones del hook y solo renderiza columnas, formulario, skeleton, estado vacío y errores. Así la interfaz cambia sin tocar la persistencia, verificada con tests sin navegador.

La consistencia en tiempo real se garantiza con cuatro reglas. Primera, deduplicación: el autor de un insert recibe también su propio evento, por lo que cada INSERT se descarta si su id ya existe en memoria. Segunda, el handler se registra una sola vez y nunca lee estado capturado; usa `setState` funcional y una ref con las opciones vigentes. Tercera, orden: un UPDATE solo se aplica si su `updated_at`, fijado por un trigger del servidor, es más reciente que el de la fila local. Cuarta, recuperación: cada vez que el canal vuelve a quedar suscrito, la pestaña recupera el foco o regresa la red, se recarga la lista en silencio, porque Realtime no reenvía eventos perdidos.

Las mutaciones son optimistas. El insert usa un id temporal que se reconcilia con la fila devuelta por `.select().single()`; si Supabase falla, se restaura el snapshot de esa fila, no la lista entera, para no deshacer cambios ajenos, y se muestra el error traducido. La limpieza llama a `removeChannel`, el canal vive en una ref protegida contra el doble montaje de StrictMode y un AbortController descarta respuestas tardías.

## 4. Cumplimiento de la rúbrica

| Criterio | Evidencia |
|---|---|
| **Abstracción y modularidad** | Hook genérico reutilizado por 3 entidades; estado `loading/success/error` como unión discriminada; `grep "supabase" src/components/` → vacío |
| **Ejecución técnica** | Cliente único tipado; `postgres_changes` dentro de `useEffect`; insert/update/delete optimistas con rollback; consultas sujetas a RLS |
| **Ciclo de vida** | `removeChannel` en la limpieza, canal en `useRef` con protección para StrictMode, cierre del canal al cambiar de proyecto, `AbortController` |

**Verificación:** `npm run build` sin errores, 11 tests de Vitest en verde (StrictMode, limpieza, deduplicación, orden y rollback) y app probada con dos usuarios en tiempo real.
