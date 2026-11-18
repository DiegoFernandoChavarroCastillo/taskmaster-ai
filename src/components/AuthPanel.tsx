import { useState, type FormEvent } from 'react'
import type { UseAuthResult } from '../hooks/useAuth'

interface AuthPanelProps {
  signIn: UseAuthResult['signIn']
  signUp: UseAuthResult['signUp']
}

export function AuthPanel({ signIn, signUp }: AuthPanelProps) {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setMessage(null)
    if (mode === 'signin') {
      const result = await signIn(email, password)
      if (!result.ok) setMessage({ kind: 'error', text: result.error })
    } else {
      const result = await signUp(email, password, fullName)
      if (!result.ok) setMessage({ kind: 'error', text: result.error })
      else if (result.data.needsConfirmation) {
        setMessage({ kind: 'ok', text: 'Cuenta creada. Revisa tu correo para confirmarla y luego inicia sesión.' })
      }
    }
    setBusy(false)
  }

  const input =
    'rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200'

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4">
      <h1 className="text-3xl font-bold tracking-tight">TaskMaster AI</h1>
      <p className="mt-1 text-sm text-slate-500">Gestión de proyectos colaborativa en tiempo real.</p>
      <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        {mode === 'signup' && (
          <>
            <label htmlFor="auth-name" className="text-sm font-medium">Nombre</label>
            <input id="auth-name" required maxLength={100} autoComplete="name" value={fullName} onChange={(e) => setFullName(e.target.value)} className={input} />
          </>
        )}
        <label htmlFor="auth-email" className="text-sm font-medium">Correo</label>
        <input id="auth-email" type="email" required maxLength={254} autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className={input} />
        <label htmlFor="auth-password" className="text-sm font-medium">Contraseña</label>
        <input
          id="auth-password"
          type="password"
          required
          minLength={mode === 'signup' ? 8 : undefined}
          maxLength={72}
          autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={input}
        />
        <button
          type="submit"
          disabled={busy}
          className="mt-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {mode === 'signin' ? 'Entrar' : 'Crear cuenta'}
        </button>
        <p aria-live="polite" className={`text-sm ${message?.kind === 'error' ? 'text-red-700' : 'text-emerald-700'}`}>
          {message?.text}
        </p>
      </form>
      <button
        type="button"
        onClick={() => setMode((m) => (m === 'signin' ? 'signup' : 'signin'))}
        className="mt-4 text-sm text-indigo-700 hover:underline"
      >
        {mode === 'signin' ? '¿No tienes cuenta? Regístrate' : '¿Ya tienes cuenta? Inicia sesión'}
      </button>
    </main>
  )
}
