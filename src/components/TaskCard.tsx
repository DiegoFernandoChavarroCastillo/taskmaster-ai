import { useState } from 'react'
import type { Member } from '../hooks/useProjectMembers'
import type { TaskPatch } from '../hooks/useTasks'
import { TASK_PRIORITIES, TASK_STATUSES, type Task, type TaskPriority } from '../lib/database.types'
import { CommentThread } from './CommentThread'
import { PRIORITY_LABEL, STATUS_LABEL } from './labels'

const PRIORITY_STYLE: Record<TaskPriority, string> = {
  baja: 'bg-slate-100 text-slate-700',
  media: 'bg-amber-100 text-amber-800',
  alta: 'bg-red-100 text-red-800',
}

interface TaskCardProps {
  task: Task
  members: readonly Member[]
  disabled: boolean
  onUpdate: (patch: TaskPatch) => void
  onDelete: () => void
}

export function TaskCard({ task, members, disabled, onUpdate, onDelete }: TaskCardProps) {
  const [showComments, setShowComments] = useState(false)
  const index = TASK_STATUSES.indexOf(task.status)
  const prev = TASK_STATUSES[index - 1]
  const next = TASK_STATUSES[index + 1]

  return (
    <article className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-medium break-words">{task.title}</h3>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${PRIORITY_STYLE[task.priority]}`}>
          {PRIORITY_LABEL[task.priority]}
        </span>
      </div>
      {task.description && <p className="text-sm text-slate-600 break-words">{task.description}</p>}

      <div className="flex flex-wrap gap-2 text-xs">
        <label className="sr-only" htmlFor={`assignee-${task.id}`}>Responsable</label>
        <select
          id={`assignee-${task.id}`}
          value={task.assignee_id ?? ''}
          disabled={disabled}
          onChange={(e) => onUpdate({ assignee_id: e.target.value || null })}
          className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1 disabled:opacity-50"
        >
          <option value="">Sin asignar</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.full_name ?? 'Sin nombre'}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor={`priority-${task.id}`}>Prioridad</label>
        <select
          id={`priority-${task.id}`}
          value={task.priority}
          disabled={disabled}
          onChange={(e) => onUpdate({ priority: e.target.value as TaskPriority })}
          className="rounded border border-slate-300 px-2 py-1 disabled:opacity-50"
        >
          {TASK_PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABEL[p]}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap items-center gap-1 pt-1">
        <button
          type="button"
          disabled={disabled || !prev}
          onClick={() => prev && onUpdate({ status: prev })}
          className="rounded px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-40"
          aria-label={prev ? `Mover a ${STATUS_LABEL[prev]}` : 'Sin estado anterior'}
        >
          ←
        </button>
        <button
          type="button"
          disabled={disabled || !next}
          onClick={() => next && onUpdate({ status: next })}
          className="rounded px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-40"
          aria-label={next ? `Mover a ${STATUS_LABEL[next]}` : 'Sin estado siguiente'}
        >
          →
        </button>
        <button
          type="button"
          onClick={() => setShowComments((v) => !v)}
          aria-expanded={showComments}
          className="ml-auto rounded px-2 py-1 text-xs text-indigo-700 hover:bg-indigo-50"
        >
          Comentarios
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={onDelete}
          className="rounded px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-40"
        >
          Borrar
        </button>
      </div>

      {showComments && <CommentThread taskId={task.id} members={members} />}
    </article>
  )
}
