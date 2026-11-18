import { lazy, Suspense, useEffect } from 'react'
import { useAuth } from './hooks/useAuth'

// PERFORMANCE · Code splitting por "ruta".
// La app tiene dos pantallas excluyentes: login y área de trabajo. Cada una se
// descarga solo cuando hace falta; quien llega al login no paga el tablero,
// los comentarios ni la lógica de Realtime, y viceversa.
const loadWorkspace = () => import('./components/Workspace')
const AuthPanel = lazy(() => import('./components/AuthPanel').then((m) => ({ default: m.AuthPanel })))
const Workspace = lazy(() => loadWorkspace().then((m) => ({ default: m.Workspace })))

function ScreenFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center text-sm text-slate-500" aria-busy="true">
      Cargando…
    </div>
  )
}

export default function App() {
  const { auth, signIn, signUp, signOut } = useAuth()

  // Mientras el usuario escribe sus credenciales, el navegador está ocioso:
  // se precarga el chunk del área de trabajo para que entrar sea instantáneo.
  useEffect(() => {
    if (auth.status !== 'signed-out') return
    const prefetch = () => void loadWorkspace()
    if ('requestIdleCallback' in window) {
      const id = window.requestIdleCallback(prefetch)
      return () => window.cancelIdleCallback(id)
    }
    const timer = setTimeout(prefetch, 1500)
    return () => clearTimeout(timer)
  }, [auth.status])

  return (
    <Suspense fallback={<ScreenFallback />}>
      {auth.status === 'loading' && <ScreenFallback />}
      {auth.status === 'signed-out' && <AuthPanel signIn={signIn} signUp={signUp} />}
      {auth.status === 'signed-in' && (
        <Workspace userId={auth.userId} email={auth.email} onSignOut={() => void signOut()} />
      )}
    </Suspense>
  )
}
