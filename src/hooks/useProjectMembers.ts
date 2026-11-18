import { supabase } from '../lib/supabase'
import { useRealtimeList, type ListStatus, type QueryResult } from './useRealtimeList'

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

  return { members: list.data, status: list.status, error: list.error }
}
