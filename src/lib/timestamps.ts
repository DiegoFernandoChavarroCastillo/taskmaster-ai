/**
 * Compara dos timestamptz serializados por Postgres
 * ("2026-11-18T10:20:30.123456+00:00").
 *
 * Date.parse solo conserva milisegundos y Postgres guarda microsegundos: dos
 * UPDATE dentro del mismo milisegundo empatarían. Por eso, ante empate en ms,
 * se desempata con los microsegundos restantes.
 *
 * Devuelve > 0 si a es más reciente, < 0 si es más antiguo y 0 si son iguales.
 */
export function compareTimestamps(a: string, b: string): number {
  const msDiff = Date.parse(a) - Date.parse(b)
  if (msDiff !== 0 && !Number.isNaN(msDiff)) return msDiff
  return subMillisecond(a) - subMillisecond(b)
}

function subMillisecond(timestamp: string): number {
  const fraction = /\.(\d+)/.exec(timestamp)?.[1] ?? ''
  return Number(fraction.padEnd(6, '0').slice(3, 6))
}

export const byCreatedAt = <T extends { created_at: string }>(a: T, b: T): number =>
  compareTimestamps(a.created_at, b.created_at)
