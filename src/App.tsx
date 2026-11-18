import { AuthPanel } from './components/AuthPanel'
import { Workspace } from './components/Workspace'
import { useAuth } from './hooks/useAuth'

export default function App() {
  const { auth, signIn, signUp, signOut } = useAuth()

  switch (auth.status) {
    case 'loading':
      return (
        <div className="flex min-h-screen items-center justify-center text-sm text-slate-500" aria-busy="true">
          Cargando…
        </div>
      )
    case 'signed-out':
      return <AuthPanel signIn={signIn} signUp={signUp} />
    case 'signed-in':
      return <Workspace userId={auth.userId} email={auth.email} onSignOut={() => void signOut()} />
  }
}
