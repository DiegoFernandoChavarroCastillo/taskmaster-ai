import { useState, type FormEvent } from 'react'
import type { Member } from '../hooks/useProjectMembers'
import type { MutationResult } from '../hooks/useTasks'

interface MembersBarProps {
  members: readonly Member[]
  onInvite: (email: string) => Promise<MutationResult<{ userId: string }>>
}

const initials = (name: string | null) =>
  (name ?? '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('')

export function MembersBar({ members, onInvite }: MembersBarProps) {
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    const result = await onInvite(email)
    setBusy(false)
    if (result.ok) {
      setEmail('')
      setMessage({ kind: 'ok', text: 'Miembro añadido.' })
    } else {
      setMessage({ kind: 'error', text: result.error })
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-2">
        <ul className="flex -space-x-2" aria-label="Miembros del proyecto">
          {members.slice(0, 6).map((m) => (
            <li
              key={m.id}
              title={m.full_name ?? 'Sin nombre'}
              className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-white bg-indigo-100 text-xs font-semibold text-indigo-800"
            >
              {initials(m.full_name)}
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm hover:bg-white"
        >
          Invitar
        </button>
      </div>
      {open && (
        <form onSubmit={handleSubmit} className="flex flex-wrap justify-end gap-2">
          <label className="sr-only" htmlFor="invite-email">Correo</label>
          <input
            id="invite-email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="correo@ejemplo.com"
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm text-white disabled:opacity-50"
          >
            Añadir
          </button>
          <p aria-live="polite" className={`w-full text-right text-xs ${message?.kind === 'error' ? 'text-red-700' : 'text-emerald-700'}`}>
            {message?.text}
          </p>
        </form>
      )}
    </div>
  )
}
