import { useCallback } from 'react'
import type { Project } from '../lib/database.types'
import { translateError } from '../lib/errors'
import { supabase } from '../lib/supabase'
import { byCreatedAt } from '../lib/timestamps'
import { upsertById, useRealtimeList, type ListStatus } from './useRealtimeList'
import type { MutationResult } from './useTasks'

export interface UseProjectsResult {
  projects: readonly Project[]
  status: ListStatus
  error: string | null
  createProject: (name: string) => Promise<MutationResult<Project>>
}

/**
 * Proyectos del usuario. Escucha project_members filtrado por su user_id:
 * cuando alguien lo añade a un proyecto (o lo quita), la lista se recarga
 * sola. RLS se encarga de que la consulta solo devuelva sus proyectos.
 */
export function useProjects(userId: string): UseProjectsResult {
  const list = useRealtimeList<Project>({
    table: 'project_members',
    filter: { column: 'user_id', value: userId },
    enabled: userId !== '',
    strategy: 'refetch',
    sort: byCreatedAt,
    query: (signal) =>
      supabase.from('projects').select('*').order('created_at', { ascending: true }).abortSignal(signal),
  })
  const { mutate } = list

  const createProject = useCallback(
    async (rawName: string): Promise<MutationResult<Project>> => {
      const name = rawName.trim()
      if (!name) return { ok: false, error: 'El nombre del proyecto es obligatorio.' }
      const { data, error } = await supabase
        .from('projects')
        .insert({ name, owner_id: userId })
        .select()
        .single()
      if (error || !data) return { ok: false, error: translateError(error) }
      mutate((rows) => upsertById(rows, data))
      return { ok: true, data }
    },
    [userId, mutate],
  )

  return { projects: list.data, status: list.status, error: list.error, createProject }
}
