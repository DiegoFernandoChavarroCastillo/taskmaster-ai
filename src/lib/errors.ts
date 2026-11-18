/**
 * Traduce errores de PostgREST / Postgres / red a mensajes en español
 * aptos para mostrarse al usuario. Nunca expone detalles internos de SQL.
 */

interface ErrorLike {
  code?: unknown
  message?: unknown
  name?: unknown
}

const BY_CODE: Readonly<Record<string, string>> = {
  // Postgres
  '42501': 'No tienes permisos para realizar esta acción en el proyecto.',
  '23503': 'La operación hace referencia a un elemento que no existe (proyecto, tarea o usuario).',
  '23505': 'Ya existe un elemento con esos datos.',
  '23514': 'Algún campo no cumple las reglas de validación (por ejemplo, un título vacío o demasiado largo).',
  '23502': 'Falta un campo obligatorio.',
  '22P02': 'Alguno de los valores enviados no tiene un formato válido.',
  P0002: 'No existe ningún usuario registrado con ese correo.',
  // PostgREST
  PGRST116: 'El elemento ya no existe o no tienes permisos para modificarlo.',
  PGRST301: 'Tu sesión ha caducado. Vuelve a iniciar sesión.',
  PGRST303: 'Tu sesión ha caducado. Vuelve a iniciar sesión.',
}

function isErrorLike(value: unknown): value is ErrorLike {
  return typeof value === 'object' && value !== null
}

export function isAbortError(error: unknown): boolean {
  if (!isErrorLike(error)) return false
  return (
    error.name === 'AbortError' ||
    error.code === '20' || // DOMException.ABORT_ERR serializado por postgrest-js
    (typeof error.message === 'string' && error.message.includes('AbortError'))
  )
}

export function translateError(error: unknown): string {
  if (!isErrorLike(error)) return 'Ha ocurrido un error inesperado.'

  if (typeof error.code === 'string') {
    const known = BY_CODE[error.code]
    if (known) return known
  }

  const message = typeof error.message === 'string' ? error.message : ''
  if (/failed to fetch|networkerror|network request failed|load failed/i.test(message)) {
    return 'Sin conexión con el servidor. Comprueba tu red e inténtalo de nuevo.'
  }
  if (/jwt|token/i.test(message)) {
    return 'Tu sesión ha caducado. Vuelve a iniciar sesión.'
  }
  if (/invalid login credentials/i.test(message)) {
    return 'Correo o contraseña incorrectos.'
  }
  if (/row-level security/i.test(message)) {
    return BY_CODE['42501'] ?? 'No tienes permisos.'
  }
  return 'No se pudo completar la operación. Inténtalo de nuevo.'
}
