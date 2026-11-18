import type { Session } from '@supabase/supabase-js'
import { useCallback, useEffect, useState } from 'react'
import { translateError } from '../lib/errors'
import { supabase } from '../lib/supabase'
import type { MutationResult } from './useTasks'

export type AuthState =
  | { status: 'loading' }
  | { status: 'signed-out' }
  | { status: 'signed-in'; userId: string; email: string | null }

function fromSession(session: Session | null): AuthState {
  return session
    ? { status: 'signed-in', userId: session.user.id, email: session.user.email ?? null }
    : { status: 'signed-out' }
}

export interface UseAuthResult {
  auth: AuthState
  signIn: (email: string, password: string) => Promise<MutationResult<null>>
  signUp: (email: string, password: string, fullName: string) => Promise<MutationResult<{ needsConfirmation: boolean }>>
  signOut: () => Promise<void>
}

export function useAuth(): UseAuthResult {
  const [auth, setAuth] = useState<AuthState>({ status: 'loading' })

  useEffect(() => {
    let active = true
    void supabase.auth.getSession().then(({ data }) => {
      if (active) setAuth(fromSession(data.session))
    })
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      if (active) setAuth(fromSession(session))
    })
    return () => {
      active = false
      data.subscription.unsubscribe()
    }
  }, [])

  const signIn = useCallback(async (email: string, password: string): Promise<MutationResult<null>> => {
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    return error ? { ok: false, error: translateError(error) } : { ok: true, data: null }
  }, [])

  const signUp = useCallback(
    async (email: string, password: string, fullName: string): Promise<MutationResult<{ needsConfirmation: boolean }>> => {
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: { data: { full_name: fullName.trim() } },
      })
      if (error) return { ok: false, error: translateError(error) }
      return { ok: true, data: { needsConfirmation: data.session === null } }
    },
    [],
  )

  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
  }, [])

  return { auth, signIn, signUp, signOut }
}
