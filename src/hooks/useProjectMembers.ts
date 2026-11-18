import { useCallback } from 'react'
import { translateError } from '../lib/errors'
import { supabase } from '../lib/supabase'
import { useRealtimeList, type ListStatus, type QueryResult } from './useRealtimeList'
import type { MutationResult } from './useTasks'

/** Miembro del proyecto: perfil público identificado por el id del usuario. */
export type Member = {
  id: string
  full_name: string | null
  avatar_url: string | null
}

export interface UseProjectMembersResult {
  members: readonly Member[]
  status: ListStatus
  error: string | null
  /** Invita por correo (solo el dueño). La lista se actualiza vía Realtime. */
  addMember: (email: string) => Promise<MutationResult<{ userId: string }>>
}

const byName = (a: Member, b: Member): number =>
  (a.full_name ?? '').localeCompare(b.full_name ?? '', 'es')

/**
 * Miembros de un proyecto en tiempo real.
 *
 * Tercer uso del hook genérico, ahora con la estrategia 'refetch': la tabla
 * escuchada (project_members, PK compuesta) no coincide con la fila que se
 * muestra (join con profiles), así que cada evento dispara una recarga
 * silenciosa con debounce en lugar de un parche local.
 */
export function useProjectMembers(projectId: string): UseProjectMembersResult {
  const list = useRealtimeList<Member>({
    table: 'project_members',
    filter: { column: 'project_id', value: projectId },
    enabled: projectId !== '',
    strategy: 'refetch',
    sort: byName,
    query: (signal): QueryResult<Member> =>
      supabase
        .from('project_members')
        .select('user_id, profiles(id, full_name, avatar_url)')
        .eq('project_id', projectId)
        .abortSignal(signal)
        .then(({ data, error }) => ({
          data:
            data?.flatMap((row) =>
              row.profiles
                ? [{ id: row.user_id, full_name: row.profiles.full_name, avatar_url: row.profiles.avatar_url }]
                : [],
            ) ?? null,
          error,
        })),
  })

  const { refetch } = list
  const addMember = useCallback(
    async (rawEmail: string): Promise<MutationResult<{ userId: string }>> => {
      const email = rawEmail.trim()
      if (!email) return { ok: false, error: 'Escribe el correo de la persona a invitar.' }
      const { data, error } = await supabase.rpc('add_project_member_by_email', {
        p_project_id: projectId,
        p_email: email,
      })
      if (error) return { ok: false, error: translateError(error) }
      void refetch({ silent: true })
      return { ok: true, data: { userId: data } }
    },
    [projectId, refetch],
  )

  return { members: list.data, status: list.status, error: list.error, addMember }
}
