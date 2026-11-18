import { useState, type FormEvent } from 'react'
import { useProjects } from '../hooks/useProjects'
import { TaskBoard } from './TaskBoard'

interface WorkspaceProps {
  userId: string
  email: string | null
  onSignOut: () => void
}

export function Workspace({ userId, email, onSignOut }: WorkspaceProps) {
  const { projects, status, error, createProject } = useProjects(userId)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const selected = projects.find((p) => p.id === selectedId) ?? projects[0] ?? null

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setCreating(true)
    const result = await createProject(name)
    setCreating(false)
    if (result.ok) {
      setName('')
      setCreateError(null)
      setSelectedId(result.data.id)
    } else {
      setCreateError(result.error)
    }
  }

  return (
    <div className="mx-auto grid min-h-screen max-w-7xl gap-6 px-4 py-6 lg:grid-cols-[16rem_1fr]">
      <aside className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <span className="text-lg font-bold">TaskMaster AI</span>
          <button type="button" onClick={onSignOut} className="text-xs text-slate-500 hover:underline">
            Salir
          </button>
        </div>
        <p className="truncate text-xs text-slate-500">{email}</p>

        <nav aria-label="Proyectos">
          <ul className="flex flex-col gap-1">
            {status === 'loading' && projects.length === 0 &&
              [0, 1].map((i) => <li key={i} className="h-9 animate-pulse rounded-lg bg-slate-200" />)}
            {projects.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(p.id)}
                  aria-current={selected?.id === p.id ? 'page' : undefined}
                  className={`w-full truncate rounded-lg px-3 py-2 text-left text-sm ${
                    selected?.id === p.id ? 'bg-indigo-600 text-white' : 'hover:bg-slate-200'
                  }`}
                >
                  {p.name}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <form onSubmit={handleCreate} className="flex gap-2">
          <label className="sr-only" htmlFor="project-name">Nombre del proyecto</label>
          <input
            id="project-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Nuevo proyecto"
            maxLength={120}
            className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
          />
          <button
            type="submit"
            disabled={creating || name.trim() === ''}
            className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm text-white disabled:opacity-50"
          >
            +
          </button>
        </form>
        <div aria-live="polite" className="empty:hidden">
          {(createError ?? error) && <p className="text-xs text-red-700">{createError ?? error}</p>}
        </div>
      </aside>

      <main>
        {selected ? (
          <TaskBoard key={selected.id} projectId={selected.id} projectName={selected.name} />
        ) : (
          status !== 'loading' && (
            <div className="rounded-xl border-2 border-dashed border-slate-300 px-6 py-16 text-center text-slate-600">
              Crea tu primer proyecto en el panel lateral.
            </div>
          )
        )}
      </main>
    </div>
  )
}
