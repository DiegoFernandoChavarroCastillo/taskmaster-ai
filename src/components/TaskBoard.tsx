import { useState, type FormEvent } from 'react'
import { useProjectMembers } from '../hooks/useProjectMembers'
import { useTasks } from '../hooks/useTasks'
import { TASK_PRIORITIES, TASK_STATUSES, type TaskPriority } from '../lib/database.types'
import { PRIORITY_LABEL, STATUS_LABEL } from './labels'
import { MembersBar } from './MembersBar'
import { TaskCard } from './TaskCard'

const REALTIME_LABEL = {
  off: { text: 'Sin conexión en vivo', dot: 'bg-slate-400' },
  connecting: { text: 'Conectando…', dot: 'bg-amber-400 animate-pulse' },
  live: { text: 'En vivo', dot: 'bg-emerald-500' },
  reconnecting: { text: 'Reconectando…', dot: 'bg-amber-500 animate-pulse' },
} as const

interface TaskBoardProps {
  projectId: string
  projectName: string
}

/**
 * Tablero de tareas. Solo renderiza: toda la persistencia y el tiempo real
 * llegan encapsulados en useTasks / useProjectMembers.
 */
export function TaskBoard({ projectId, projectName }: TaskBoardProps) {
  const { tasks, status, error, createTask, updateTask, deleteTask, isMutating, realtime } =
    useTasks(projectId)
  const { members, addMember } = useProjectMembers(projectId)

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState<TaskPriority>('media')

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const result = await createTask({ title, description, priority })
    if (result.ok) {
      setTitle('')
      setDescription('')
      setPriority('media')
    }
  }

  const isInitialLoading = status === 'loading' && tasks.length === 0
  const live = REALTIME_LABEL[realtime]

  return (
    <section className="flex flex-col gap-6" aria-labelledby="board-title">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 id="board-title" className="text-2xl font-bold tracking-tight">
            {projectName}
          </h1>
          <p className="mt-1 flex items-center gap-2 text-sm text-slate-500">
            <span className={`inline-block h-2 w-2 rounded-full ${live.dot}`} aria-hidden="true" />
            {live.text} · {tasks.length} {tasks.length === 1 ? 'tarea' : 'tareas'}
          </p>
        </div>
        <MembersBar members={members} onInvite={addMember} />
      </header>

      <form
        onSubmit={handleSubmit}
        className="grid gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-[1fr_1fr_auto_auto]"
      >
        <label className="sr-only" htmlFor="task-title">Título</label>
        <input
          id="task-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Nueva tarea…"
          maxLength={200}
          required
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
        />
        <label className="sr-only" htmlFor="task-description">Descripción</label>
        <input
          id="task-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Descripción (opcional)"
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
        />
        <label className="sr-only" htmlFor="task-priority">Prioridad</label>
        <select
          id="task-priority"
          value={priority}
          onChange={(e) => setPriority(e.target.value as TaskPriority)}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
        >
          {TASK_PRIORITIES.map((p) => (
            <option key={p} value={p}>
              Prioridad {PRIORITY_LABEL[p].toLowerCase()}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={isMutating || title.trim() === ''}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isMutating ? 'Guardando…' : 'Crear tarea'}
        </button>
      </form>

      {/* Región viva: los lectores de pantalla anuncian los errores al aparecer. */}
      <div aria-live="assertive" role="status" className="empty:hidden">
        {error && (
          <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</p>
        )}
      </div>

      {isInitialLoading ? (
        <BoardSkeleton />
      ) : status === 'success' && tasks.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed border-slate-300 px-6 py-16 text-center">
          <p className="text-lg font-semibold text-slate-700">Este proyecto aún no tiene tareas</p>
          <p className="mt-1 text-sm text-slate-500">Crea la primera con el formulario de arriba.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {TASK_STATUSES.map((column) => {
            const columnTasks = tasks.filter((task) => task.status === column)
            return (
              <section
                key={column}
                aria-labelledby={`col-${column}`}
                className="flex flex-col gap-3 rounded-xl bg-slate-100 p-3"
              >
                <h2 id={`col-${column}`} className="flex items-center justify-between px-1 text-sm font-semibold text-slate-600">
                  {STATUS_LABEL[column]}
                  <span className="rounded-full bg-white px-2 py-0.5 text-xs">{columnTasks.length}</span>
                </h2>
                {columnTasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    members={members}
                    disabled={isMutating}
                    onUpdate={(patch) => void updateTask(task.id, patch)}
                    onDelete={() => void deleteTask(task.id)}
                  />
                ))}
              </section>
            )
          })}
        </div>
      )}
    </section>
  )
}

function BoardSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3" aria-busy="true" aria-label="Cargando tareas">
      {TASK_STATUSES.map((column) => (
        <div key={column} className="flex flex-col gap-3 rounded-xl bg-slate-100 p-3">
          <div className="h-4 w-24 animate-pulse rounded bg-slate-300" />
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-24 animate-pulse rounded-lg bg-white" />
          ))}
        </div>
      ))}
    </div>
  )
}
