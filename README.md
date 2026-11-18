# TaskMaster AI

Plataforma de gestión de proyectos colaborativos con tareas en tiempo real.
React 18 · TypeScript estricto · Vite · Tailwind CSS v4 · Supabase.

La entrega académica (código de `useTasks`, memoria técnica y rúbrica) está en [`ENTREGA.md`](./ENTREGA.md).

## Puesta en marcha

1. **Crear el proyecto en Supabase** (https://supabase.com/dashboard).
2. **Aplicar el esquema**: en *SQL Editor*, pega y ejecuta `supabase/migrations/0001_taskmaster.sql`
   (o `npx supabase db push` si usas la CLI enlazada al proyecto).
3. **Variables de entorno**:
   ```bash
   cp .env.example .env.local
   # rellena VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY (Project Settings → API)
   ```
   `.env.local` está en `.gitignore` y nunca se versiona.
4. **Auth**: para pruebas rápidas, en *Authentication → Providers → Email* puedes desactivar
   *Confirm email*; si no, cada cuenta debe confirmarse por correo antes de entrar.
5. **Ejecutar**:
   ```bash
   npm install
   npm run dev
   ```

## Probar el tiempo real

1. Registra dos cuentas (A y B), cada una en un navegador o perfil distinto.
2. Con A, crea un proyecto y pulsa **Invitar** con el correo de B.
3. B verá el proyecto aparecer solo. Crear, mover o borrar tareas en una ventana se refleja
   en la otra sin recargar; el indicador "En vivo" muestra el estado del canal.

## Scripts

| Comando | Qué hace |
|---|---|
| `npm run dev` | Servidor de desarrollo (StrictMode activo) |
| `npm run build` | `tsc -b` + build de producción |
| `npm run lint` | oxlint |
| `npm test` | Tests de Vitest del contrato de Realtime y ciclo de vida (cliente simulado) |

## Estructura

```
supabase/migrations/0001_taskmaster.sql   esquema, índices, RLS, Realtime
src/lib/        cliente único tipado, tipos del esquema, errores en español, timestamps
src/hooks/      useRealtimeList (genérico) + useTasks, useComments, useProjectMembers,
                useProjects, useAuth (únicos puntos que hablan con el backend)
src/components/ TaskBoard, TaskCard, CommentThread, MembersBar, Workspace, AuthPanel
```
