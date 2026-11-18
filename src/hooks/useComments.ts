import { useCallback, useEffect, useRef, useState } from 'react'
import type { Comment } from '../lib/database.types'
import { translateError } from '../lib/errors'
import { supabase } from '../lib/supabase'
import { byCreatedAt } from '../lib/timestamps'
import { upsertById, useRealtimeList, type ListStatus } from './useRealtimeList'
import type { MutationResult } from './useTasks'

export interface UseCommentsResult {
  comments: readonly Comment[]
  status: ListStatus
  error: string | null
  addComment: (body: string) => Promise<MutationResult<Comment>>
  isSending: boolean
}

/**
 * Comentarios de una tarea en tiempo real. Reutiliza useRealtimeList con
 * otra tabla y otro filtro (`comments:${taskId}`, `task_id=eq.${taskId}`):
 * la abstracción no es un caso único de tareas.
 */
export function useComments(taskId: string): UseCommentsResult {
  const list = useRealtimeList<Comment>({
    table: 'comments',
    filter: { column: 'task_id', value: taskId },
    enabled: taskId !== '',
    query: (signal) =>
      supabase
        .from('comments')
        .select('*')
        .eq('task_id', taskId)
        .order('created_at', { ascending: true })
        .abortSignal(signal),
    sort: byCreatedAt,
  })
  const { mutate } = list

  const [sending, setSending] = useState(0)
  const [sendError, setSendError] = useState<string | null>(null)
  const isMountedRef = useRef(false)
  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  const addComment = useCallback(
    async (rawBody: string): Promise<MutationResult<Comment>> => {
      const body = rawBody.trim()
      if (!body) return { ok: false, error: 'El comentario no puede estar vacío.' }

      const { data: auth } = await supabase.auth.getSession()
      const authorId = auth.session?.user.id
      if (!authorId) return { ok: false, error: 'Tu sesión ha caducado. Vuelve a iniciar sesión.' }

      setSending((n) => n + 1)
      setSendError(null)
      const tempId = crypto.randomUUID()
      const optimistic: Comment = {
        id: tempId,
        task_id: taskId,
        author_id: authorId,
        body,
        created_at: new Date().toISOString(),
      }
      mutate((rows) => [...rows, optimistic])

      try {
        const { data, error } = await supabase
          .from('comments')
          .insert({ task_id: taskId, author_id: authorId, body })
          .select()
          .single()

        if (error || !data) {
          mutate((rows) => rows.filter((row) => row.id !== tempId))
          const message = translateError(error)
          if (isMountedRef.current) setSendError(message)
          return { ok: false, error: message }
        }
        // Reconciliación + deduplicación frente al INSERT de Realtime.
        mutate((rows) => upsertById(rows.filter((row) => row.id !== tempId), data))
        return { ok: true, data }
      } finally {
        if (isMountedRef.current) setSending((n) => n - 1)
      }
    },
    [taskId, mutate],
  )

  return {
    comments: list.data,
    status: list.status,
    error: sendError ?? list.error,
    addComment,
    isSending: sending > 0,
  }
}
