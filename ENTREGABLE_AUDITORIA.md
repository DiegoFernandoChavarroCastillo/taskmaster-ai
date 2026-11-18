# Auditoría de IA y Optimización Final · TaskMaster AI

**Repositorio:** https://github.com/DiegoFernandoChavarroCastillo/taskmaster-ai · informe extendido en `AUDITORIA.md`
**Stack:** React 18 + Vite 8 + Supabase · **Auditor IA:** Claude (Claude Code) · aplicado al proyecto real del curso (escenario "EcoMart")

## 1. Proceso: Arquitectura Basada en Especificaciones

Cada prompt partió de una especificación verificable, y ninguna respuesta de la IA se aceptó sin contrastarla con el código y con mediciones.

**Especificaciones:**
- **E1.** Solo los miembros acceden a los datos de su proyecto.
- **E2.** El servidor es la única fuente de verdad para fechas e identidad.
- **E3.** Ningún secreto que salte RLS llega al navegador.
- **E4.** Ninguna API revela datos ajenos.

| # | Prompt a la IA | Resultado | Verificación / decisión |
|---|---|---|---|
| 1 | *"Actúa como experto en ciberseguridad. Analiza este código React (AuthPanel, TaskBoard) y las políticas RLS en busca de XSS, inyección y fallos de autenticación. Propón correcciones."* | Sin sumideros XSS; PostgREST parametriza las consultas. Detecta **H1** | `grep` confirma que no hay `dangerouslySetInnerHTML`/`innerHTML`; H1 confirmado leyendo la política |
| 2 | *"Contrasta cada GRANT con E2 y describe un ataque paso a paso por columna escribible."* | Detecta **H2** (asignación masiva) | Reproducido contra la lógica de orden de Realtime |
| 3 | *"Enumera lo que PostgREST expone en `public` y evalúalo contra E4."* | Detecta **H3** (oráculo RPC) | Confirmado: `SECURITY DEFINER` en `public` = endpoint público |
| 4 | *"¿Cómo llegan las claves al bundle y qué pasa si se filtra la service_role?"* | Guard de build + CSP | Implementado y probado |
| 5 | *"Estrategias de code splitting y reemplazo de dependencias pesadas (adjunto reporte del visualizer)."* | Lazy por pantalla, chunks de vendor, `target es2022`, supabase modular | 2 adoptadas, 2 **medidas y descartadas** (§3) |
| 6 | *"¿Qué riesgos residuales quedan?"* | DELETE de Realtime expone ids | Documentado con mitigación |

## 2. Los 3 hallazgos de seguridad más críticos

### H1 · Inyección de comentarios en proyectos ajenos (RLS incompleta) · Crítica
La política de UPDATE solo validaba el autor. `update({ task_id: '<tarea de otro proyecto>' })` publicaba el comentario, en tiempo real, en un proyecto donde el atacante no es miembro.

**Fragmento de código mejorado (política RLS refactorizada):**
```sql
-- ANTES
create policy "comments_update_author" on public.comments for update to authenticated
  using (author_id = (select auth.uid()))
  with check (author_id = (select auth.uid()));
-- DESPUÉS: la fila resultante debe seguir en una tarea accesible + solo `body` es editable
create policy "comments_update_author" on public.comments for update to authenticated
  using (author_id = (select auth.uid()))
  with check (author_id = (select auth.uid()) and private.can_access_task(task_id));
grant update (body) on public.comments to authenticated;
```

### H2 · Asignación masiva y envenenamiento del tiempo real · Crítica
`grant insert, update` sobre toda la tabla dejaba escribir cualquier columna. Un `insert({ ..., updated_at: '2099-01-01' })` hacía que los clientes descartaran **todas** las ediciones futuras de esa tarea, porque un UPDATE solo se aplica si su `updated_at` es más reciente. También permitía falsear `created_at` y mover tareas a otro proyecto.
```sql
revoke insert, update on public.tasks from authenticated;
grant insert (project_id, title, description, status, priority, assignee_id) on public.tasks to authenticated;
grant update (title, description, status, priority, assignee_id)             on public.tasks to authenticated;
create trigger tasks_set_server_timestamps before insert on public.tasks
  for each row execute function public.set_server_timestamps(); -- created_at = updated_at = now()
```
Se aplicó lo mismo en `comments`, `projects` y `profiles`. Escribir otra columna devuelve `42501`.

### H3 · Oráculo de pertenencia vía RPC · Alta
`/rest/v1/rpc/is_project_member` aceptaba cualquier `p_user_id` y, al ser `SECURITY DEFINER` (ignora RLS), revelaba si un usuario ajeno pertenece a un proyecto ajeno.
```sql
create schema private;  revoke all on schema private from public, anon;
alter function public.is_project_member(uuid, uuid) set schema private; -- + can_access_task, ...
```
Las políticas siguen funcionando porque referencian las funciones por OID, y el esquema `private` no lo expone la API.

**Otros hallazgos corregidos:**
- **CSP en producción:** `script-src 'self'`, y `connect-src` limitado al dominio de Supabase.
- **Registro:** contraseña de 8 o más caracteres, `maxLength` en los campos y mensajes que no enumeran cuentas.
- **Perfiles:** `CHECK` en `profiles` (longitud y `avatar_url` solo `https://`).
- **Rol `anon`:** sin acceso a ninguna tabla.
- **Riesgo residual:** los DELETE de Realtime exponen solo UUID. Mitigación futura: canales privados de Broadcast.

## 3. Optimización del bundle

**Diagnóstico** (`rollup-plugin-visualizer`, `npm run analyze`; capturas en `docs/bundle-antes.html` y `docs/bundle-despues.html`): un único JS de **384,28 KB / 109,42 KB gzip**.
- `react-dom` (47 KB gz) y `supabase-js` (~82 KB gz) suman el 92 %.
- 11,5 KB gz son módulos que la app no usa: `storage-js`, `functions-js` e `iceberg-js`.
- No hay librerías pesadas evitables tipo `moment.js`: solo 3 dependencias de producción, y las fechas se manejan con `Date`/`Intl` nativos.

**Implementación: `React.lazy()` + `Suspense` en las pantallas principales** (`src/App.tsx`):
```tsx
const loadWorkspace = () => import('./components/Workspace')
const AuthPanel = lazy(() => import('./components/AuthPanel').then((m) => ({ default: m.AuthPanel })))
const Workspace = lazy(() => loadWorkspace().then((m) => ({ default: m.Workspace })))
// …mientras el usuario escribe su contraseña: requestIdleCallback(() => loadWorkspace())
<Suspense fallback={<ScreenFallback />}>
  {auth.status === 'signed-out' && <AuthPanel signIn={signIn} signUp={signUp} />}
  {auth.status === 'signed-in' && <Workspace userId={auth.userId} … />}
</Suspense>
```
`CommentThread` también es lazy: solo se descarga al abrir un hilo.

**`vite.config.ts`, chunks de vendor** (Rolldown):
```ts
build: { rolldownOptions: { output: { codeSplitting: { groups: [
  { name: 'vendor-react',    test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 20 },
  { name: 'vendor-supabase', test: /node_modules[\\/](@supabase|iceberg-js|tslib)[\\/]/, priority: 10 },
] } } } }
```

| Métrica (`vite build`) | Antes | Después |
|---|---|---|
| JS del primer acceso (login) | 109,42 KB gz | **105,29 KB gz** (−3,8 %) |
| Código de app en el login | ~32 KB | **9,05 KB** (−72 %) |
| Tablero + Realtime | en el login | 6,40 KB gz, tras el login (precargado) |
| Comentarios | en el login | 1,39 KB gz, bajo demanda |
| Bytes invalidados por un despliegue de UI | 384 KB (100 %) | **≈32 KB (8 %)**: vendors en caché |

**Justificación técnica:** la primera pantalla necesita React y `auth-js` sí o sí, así que la ganancia en el primer byte es modesta y se reporta tal cual. El valor real está en tres puntos:
- se saca del camino crítico todo el código que no participa en el primer render;
- con chunks de vendor con hash, el 92 % del peso queda en caché entre despliegues;
- `modulepreload` descarga los vendors en paralelo.

**Propuestas de la IA medidas y descartadas:**
- **`target: 'es2022'`:** el CSS subió de 16,98 a 18,78 KB, porque el valor por defecto de Vite 8 ya es más moderno. Revertido.
- **Reemplazar supabase-js por clientes modulares** (−11,5 KB gz): obliga a reimplementar la propagación del token a Realtime. Si falla, el canal evalúa RLS como `anon` y deja de recibir eventos. Riesgo alto para una ganancia acotada: descartado.

## 4. Hardening de Supabase: variables de entorno

| Variable | Ubicación | ¿Pública? |
|---|---|---|
| `VITE_SUPABASE_URL` | `.env.local` (en `.gitignore`) | Sí |
| `VITE_SUPABASE_ANON_KEY` | `.env.local` (publishable, no salta RLS) | Sí |
| `service_role` / `sb_secret_…` | Nunca en el cliente | **No** |

- **Un solo punto de acceso a Supabase:** solo `src/lib` y `src/hooks` importan el cliente; `grep "supabase" src/components/` no devuelve nada.
- **`.env.local` no versionado:** `git ls-files` solo lista `.env.example`.
- **Guard en build** (`vite.config.ts`): si una variable `VITE_*` contiene una `sb_secret_` o un JWT con `role: service_role`, el build falla. Probado con ambos tipos de clave:
```
$ VITE_LEAK=sb_secret_abc123 npx vite build
Error: Clave secreta de Supabase en variables públicas: VITE_LEAK. Usa solo la anon/publishable key…
```

## 5. Verificación

- **Build y calidad:** `npm run build` sin errores; oxlint con 0 avisos; 11/11 tests de Vitest en verde; sin `any`.
- **CSP:** presente en el HTML de producción, sin scripts inline.
- **Migración `0003_security_hardening.sql`:** ejecutada en Supabase.
- **Prueba real:** app re-probada con dos usuarios en tiempo real (crear, mover, comentar, invitar).
