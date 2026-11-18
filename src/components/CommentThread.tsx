import { useState, type FormEvent } from 'react'
import { useComments } from '../hooks/useComments'
import type { Member } from '../hooks/useProjectMembers'

interface CommentThreadProps {
  taskId: string
  members: readonly Member[]
}

export function CommentThread({ taskId, members }: CommentThreadProps) {
  const { comments, status, error, addComment, isSending } = useComments(taskId)
  const [body, setBody] = useState('')

  const authorName = (id: string) => members.find((m) => m.id === id)?.full_name ?? 'Miembro'

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const result = await addComment(body)
    if (result.ok) setBody('')
  }

  return (
    <div className="mt-1 flex flex-col gap-2 border-t border-slate-100 pt-2">
      {status === 'loading' && comments.length === 0 && (
        <div className="h-8 animate-pulse rounded bg-slate-100" aria-label="Cargando comentarios" />
      )}
      {status === 'success' && comments.length === 0 && (
        <p className="text-xs text-slate-500">Sin comentarios todavía.</p>
      )}
      <ul className="flex flex-col gap-1.5">
        {comments.map((c) => (
          <li key={c.id} className="rounded bg-slate-50 px-2 py-1.5 text-xs">
            <span className="font-semibold">{authorName(c.author_id)}: </span>
            <span className="break-words">{c.body}</span>
          </li>
        ))}
      </ul>
      <div aria-live="polite" className="empty:hidden">
        {error && <p className="text-xs text-red-700">{error}</p>}
      </div>
      <form onSubmit={handleSubmit} className="flex gap-2">
        <label className="sr-only" htmlFor={`comment-${taskId}`}>Nuevo comentario</label>
        <input
          id={`comment-${taskId}`}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Escribe un comentario…"
          maxLength={4000}
          className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1 text-xs"
        />
        <button
          type="submit"
          disabled={isSending || body.trim() === ''}
          className="rounded bg-slate-800 px-2 py-1 text-xs text-white disabled:opacity-50"
        >
          Enviar
        </button>
      </form>
    </div>
  )
}
