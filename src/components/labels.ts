import type { TaskPriority, TaskStatus } from '../lib/database.types'

export const STATUS_LABEL: Record<TaskStatus, string> = {
  pendiente: 'Pendiente',
  en_progreso: 'En progreso',
  hecha: 'Hecha',
}

export const PRIORITY_LABEL: Record<TaskPriority, string> = {
  baja: 'Baja',
  media: 'Media',
  alta: 'Alta',
}
