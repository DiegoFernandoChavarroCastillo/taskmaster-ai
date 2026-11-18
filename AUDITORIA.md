# Informe de Auditoría de IA y Optimización Final · TaskMaster AI

| | |
|---|---|
| **Proyecto auditado** | TaskMaster AI (React 18 + Vite 8 + Supabase), aplicación real del curso |
| **Repositorio** | https://github.com/DiegoFernandoChavarroCastillo/taskmaster-ai |
| **Auditor IA** | Claude (Claude Code), con acceso de lectura al repositorio y ejecución de comandos |
| **Alcance** | Componentes de formulario (`AuthPanel`, `TaskBoard`), hooks de datos, políticas RLS y privilegios (`supabase/migrations/`), configuración de build (`vite.config.ts`) |
| **Commits** | `e25441a` (seguridad) · `4a57149` (rendimiento + hardening de build) |

> El enunciado plantea el escenario "EcoMart". La auditoría se aplicó sobre el proyecto real desarrollado en el curso, TaskMaster AI, para que los hallazgos, las correcciones y las mediciones sean verificables en el repositorio.

---

## 1. Resumen ejecutivo

| # | Hallazgo | Tipo | Severidad | Estado |
|---|---|---|---|---|
| H1 | El autor de un comentario podía moverlo a una tarea de **otro proyecto** | Fallo de autorización (RLS) | **Crítica** | Corregido |
| H2 | **Asignación masiva** de columnas: `updated_at`, `created_at` y `project_id` eran escribibles por el cliente | Inyección de datos / integridad | **Crítica** | Corregido |
| H3 | Funciones `SECURITY DEFINER` expuestas como RPC: **oráculo de pertenencia** a proyectos ajenos | Fuga de información | **Alta** | Corregido |
| H4 | Riesgo de exponer la `service_role` en variables `VITE_` | Gestión de secretos | Alta (preventivo) | Bloqueado en build |
| H5 | Sin Content-Security-Policy; registro con contraseña mínima de 6 y mensajes que enumeran cuentas | Hardening | Media | Corregido |
| R1 | Los eventos `DELETE` de Realtime revelan el `id` de filas borradas a cualquier suscriptor | Fuga de metadatos | Baja | Riesgo residual documentado |

**Rendimiento:** la pantalla de login descarga **un 72 % menos de código de aplicación**. El JS inicial baja de 109,42 a 105,29 KB gzip. **El 92 % de los bytes** (vendors) queda cacheado entre despliegues, y el tablero y los comentarios se cargan bajo demanda con `React.lazy` + `Suspense`.

---

## 2. Metodología: Arquitectura Basada en Especificaciones

La auditoría no consistió en pedirle a la IA "revisa mi código". Cada iteración partió de una **especificación verificable**: qué debe garantizar el sistema. La salida de la IA se aceptó solo tras **contrastarla con el código real y con mediciones**.

**Especificaciones de seguridad de partida:**
1. Un usuario solo puede leer o modificar datos de los proyectos de los que es miembro.
2. El servidor es la única fuente de verdad para marcas de tiempo e identidad.
3. Ningún secreto con privilegios por encima de RLS llega al navegador.
4. Ninguna API pública revela información sobre usuarios o proyectos ajenos.

### Diálogo iterativo con la IA

| Iter. | Prompt (resumido) | Respuesta de la IA | Decisión humana / verificación |
|---|---|---|---|
| 1 | *"Actúa como un experto en ciberseguridad. Analiza el siguiente código React (AuthPanel, TaskBoard) y las políticas RLS de Supabase en busca de vulnerabilidades (XSS, Inyección, fallos de autenticación). Propón correcciones específicas."* + código + `0001_taskmaster.sql` | XSS: no hay sumideros (`dangerouslySetInnerHTML`, `innerHTML`, `href` dinámico) y React escapa el texto. Inyección SQL: PostgREST parametriza todas las consultas. Detecta **H1**: la política UPDATE de `comments` no revalida `task_id` | Se verificó con `grep` que no existen sumideros XSS. H1 se confirmó leyendo la política: `with check (author_id = auth.uid())` no restringe la tarea destino |
| 2 | *"Para cada tabla, contrasta los GRANT de `0002_grants.sql` con la especificación 2 y describe un ataque concreto, paso a paso, por columna escribible."* | Detecta **H2**: con `grant insert, update` sobre la tabla completa, un `insert` con `updated_at = '2099-01-01'` hace que la regla de orden de Realtime (*aplicar UPDATE solo si `updated_at` es más reciente*) **descarte todas las ediciones futuras** de esa tarea en los demás clientes | Se reprodujo el razonamiento contra `applyRealtimeChange` (`useRealtimeList.ts`): el ataque rompe la consistencia del tiempo real sin violar ninguna política RLS. Se validó como crítico |
| 3 | *"Enumera todo lo que PostgREST expone en el esquema `public` y evalúa cada función contra la especificación 4."* | Detecta **H3**: `is_project_member(p_project_id, p_user_id)` se publica en `/rest/v1/rpc/` y, al ser `SECURITY DEFINER`, responde para **cualquier** usuario y proyecto | Confirmado: PostgREST expone las funciones de `public`, y `SECURITY DEFINER` ignora RLS. Se adoptó el patrón de Supabase de un esquema `private` no expuesto |
| 4 | *"Revisa cómo llegan las claves al bundle de Vite y qué pasaría si se filtrara la service_role."* | Todo `VITE_*` se incrusta en el JS público. Propone un **guard en build** que rechace claves `sb_secret_` o JWT con `role=service_role`, y una CSP | Implementado y **probado**: el build falla con ambos tipos de clave (sección 5) |
| 5 | *"Sugiere estrategias de code splitting y reemplazo de dependencias pesadas, con el reporte del visualizer adjunto."* | Propone: (a) `React.lazy` por pantalla, (b) chunks de vendor, (c) `build.target: 'es2022'`, (d) sustituir `supabase-js` por los clientes modulares para eliminar `storage-js`, `functions-js` e `iceberg-js` | (a) y (b) adoptados. (c) **medido y revertido**: aumentaba el CSS de 16,98 a 18,78 KB. (d) **descartado** con justificación técnica (sección 4.4) |
| 6 | *"¿Qué riesgos residuales quedan tras las correcciones?"* | Señala **R1**: con RLS activa, Supabase entrega los eventos `DELETE` a todos los suscriptores de la tabla, con solo la clave primaria | Aceptado como riesgo residual con mitigación propuesta (sección 3.4) |

---

## 3. Hallazgos críticos y su corrección

### H1 · Inyección de comentarios en proyectos ajenos (RLS incompleta)

**Escenario de ataque:** Mallory es miembro del proyecto A. Escribe un comentario en una tarea de A y, usando el cliente Supabase desde la consola del navegador, lo actualiza:
```js
await supabase.from('comments').update({ task_id: '<uuid de una tarea del proyecto B>' }).eq('id', miComentario)
```
La política solo comprobaba que Mallory fuera la autora. El comentario aparece, en tiempo real, en el proyecto B, del que no es miembro: puede meter spam o enlaces de phishing en equipos ajenos.

**Corrección (política RLS refactorizada):**
```sql
-- ANTES
create policy "comments_update_author" on public.comments for update to authenticated
  using (author_id = (select auth.uid()))
  with check (author_id = (select auth.uid()));

-- DESPUÉS: la fila resultante debe seguir perteneciendo a una tarea accesible
create policy "comments_update_author" on public.comments for update to authenticated
  using (author_id = (select auth.uid()))
  with check (author_id = (select auth.uid()) and private.can_access_task(task_id));

-- Y en profundidad: solo el texto del comentario es editable
grant update (body) on public.comments to authenticated;
```

### H2 · Asignación masiva y envenenamiento del orden de Realtime

**Escenario de ataque:** el cliente controla todas las columnas del `insert`:
```js
await supabase.from('tasks').insert({ project_id, title: 'x', updated_at: '2099-01-01T00:00:00Z' })
```
El hook de tiempo real aplica un `UPDATE` solo si su `updated_at` es más reciente que el que hay en memoria (para que un evento tardío no pise uno nuevo). Con una fecha de 2099, **ninguna edición posterior de esa tarea se mostrará a nadie**. El mismo fallo permitía falsear `created_at` y mover tareas a otro proyecto vía `update({ project_id })`.

**Corrección:** privilegios **por columna** (lista blanca) más un trigger que fija las marcas de tiempo en el servidor (defensa en profundidad):
```sql
revoke insert, update on public.tasks from authenticated;
grant insert (project_id, title, description, status, priority, assignee_id) on public.tasks to authenticated;
grant update (title, description, status, priority, assignee_id)             on public.tasks to authenticated;

create trigger tasks_set_server_timestamps before insert on public.tasks
  for each row execute function public.set_server_timestamps();  -- created_at = updated_at = now()
```
Se aplicó lo mismo a `comments` (insert `task_id, author_id, body`; update `body`), `projects` (insert `name, owner_id`; update `name`) y `profiles` (update `full_name, avatar_url`). Un intento de escribir otra columna ahora devuelve `42501 permission denied`. El cliente legítimo no cambia: los hooks ya enviaban solo columnas permitidas.

### H3 · Oráculo de pertenencia vía RPC

**Escenario de ataque:**
```bash
curl -X POST "$URL/rest/v1/rpc/is_project_member" -H "Authorization: Bearer <jwt de Mallory>" \
     -d '{"p_project_id":"<uuid>","p_user_id":"<uuid de la víctima>"}'   # → true / false
```
Al ser `SECURITY DEFINER`, la función lee `project_members` sin RLS y responde por usuarios y proyectos ajenos. Lo mismo ocurría con `shares_project_with` y `can_access_task`.

**Corrección:** las funciones auxiliares se mueven a un esquema `private` que la Data API no publica. Las políticas RLS las siguen usando, porque las referencian por OID:
```sql
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;
alter function public.is_project_member(uuid, uuid) set schema private;
alter function public.is_project_owner(uuid)         set schema private;
alter function public.can_access_task(uuid)          set schema private;
alter function public.shares_project_with(uuid)      set schema private;
```
La única RPC que sigue pública, `add_project_member_by_email`, se recreó para llamar a `private.is_project_owner`. Además, valida que solo el dueño pueda invocarla.

### 3.4 Otros hallazgos

| Hallazgo | Corrección |
|---|---|
| **Formulario de registro** (`AuthPanel.tsx`): contraseña mínima de 6, campos sin `maxLength`, y el mensaje "User already registered" permitía enumerar cuentas | `minLength={8}` al registrarse, `maxLength` (100 / 254 / 72, este último el límite de bcrypt) y un mensaje genérico que no confirma si el correo existe (`lib/errors.ts`) |
| `profiles.full_name` y `avatar_url` sin límites (metadatos controlados por el usuario en `signUp`) | `CHECK` de longitud ≤ 100, `avatar_url` solo `https://` (bloquea `javascript:`) y el trigger de registro recorta y sanea |
| Sin Content-Security-Policy | CSP inyectada en el build de producción: `script-src 'self'`, `connect-src` limitado al dominio del proyecto Supabase, `object-src 'none'`. Un XSS no podría cargar scripts externos ni exfiltrar datos a otro dominio |
| `anon` con posibles privilegios heredados | `revoke all on all tables in schema public from anon` + default privileges |
| **R1 · riesgo residual:** los `DELETE` de Realtime llegan a todos los suscriptores de `tasks` con solo el `id` (Supabase no puede aplicar RLS a filas ya borradas) | Solo se filtran UUID aleatorios, sin contenido. Mitigación futura: migrar las notificaciones a **Realtime Broadcast con canales privados** (autorizados por RLS sobre `realtime.messages`) |

---

## 4. Optimización del bundle

### 4.1 Diagnóstico (rollup-plugin-visualizer)

Reporte interactivo: [`docs/bundle-antes.html`](docs/bundle-antes.html) → [`docs/bundle-despues.html`](docs/bundle-despues.html) (regenerable con `npm run analyze`).

Composición del bundle original (un único `index.js` de **384,28 KB / 109,42 KB gzip**):

| Dependencia | Tamaño sin minificar | gzip | ¿Se usa? |
|---|---|---|---|
| `react-dom` | 180,1 KB | 47,0 KB | Sí |
| `@supabase/auth-js` | 170,1 KB | 33,3 KB | Sí (login) |
| `@supabase/realtime-js` + `phoenix` | 95,3 KB | 25,6 KB | Sí (tiempo real) |
| Código de la app | 48,8 KB | 17,0 KB | Sí, pero **todo** se cargaba en el login |
| `@supabase/storage-js` + `iceberg-js` | 48,9 KB | 9,6 KB | **No** |
| `@supabase/postgrest-js` | 31,1 KB | 7,2 KB | Sí |
| `@supabase/functions-js` | 5,6 KB | 1,9 KB | **No** |

**Auditoría de dependencias:** el proyecto no arrastra librerías pesadas evitables tipo `moment.js` o `lodash`. Solo tiene 3 dependencias de producción (`react`, `react-dom`, `@supabase/supabase-js`), y las fechas se manejan con APIs nativas (`Date`, `Intl`, `lib/timestamps.ts`).

### 4.2 Intervención

**Rutas con `React.lazy()` + `Suspense`** (`src/App.tsx`):
```tsx
const loadWorkspace = () => import('./components/Workspace')
const AuthPanel = lazy(() => import('./components/AuthPanel').then((m) => ({ default: m.AuthPanel })))
const Workspace = lazy(() => loadWorkspace().then((m) => ({ default: m.Workspace })))

export default function App() {
  const { auth, signIn, signUp, signOut } = useAuth()
  // Mientras el usuario escribe su contraseña, se precarga el área de trabajo en tiempo ocioso
  useEffect(() => {
    if (auth.status !== 'signed-out') return
    const id = window.requestIdleCallback(() => void loadWorkspace())
    return () => window.cancelIdleCallback(id)
  }, [auth.status])

  return (
    <Suspense fallback={<ScreenFallback />}>
      {auth.status === 'signed-out' && <AuthPanel signIn={signIn} signUp={signUp} />}
      {auth.status === 'signed-in' && <Workspace userId={auth.userId} email={auth.email} onSignOut={() => void signOut()} />}
    </Suspense>
  )
}
```
Además, `CommentThread` se carga solo cuando el usuario abre los comentarios de una tarea (`TaskCard.tsx`).

**`vite.config.ts`, chunks de vendor** (Vite 8 / Rolldown, `output.codeSplitting`):
```ts
build: {
  rolldownOptions: {
    output: {
      codeSplitting: {
        groups: [
          { name: 'vendor-react',    test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 20 },
          { name: 'vendor-supabase', test: /node_modules[\\/](@supabase|iceberg-js|tslib)[\\/]/, priority: 10 },
        ],
      },
    },
  },
},
```

### 4.3 Resultado (medido con `vite build`)

| Recurso | Antes | Después | Cuándo se descarga |
|---|---|---|---|
| JS total del primer acceso (login) | 384,28 KB · **109,42 KB gz** | 365,09 KB · **105,29 KB gz** (−3,8 %) | Al abrir la app |
| Código de la app en el login | ~32 KB (todo) | 9,05 KB (`index` + `AuthPanel`) (**−72 %**) | Al abrir la app |
| `Workspace` (tablero, hooks, Realtime) | incluido | 20,11 KB · 6,40 KB gz | Tras iniciar sesión (precargado en idle) |
| `CommentThread` | incluido | 2,84 KB · 1,39 KB gz | Al abrir un hilo |
| Bytes que se invalidan al redesplegar un cambio de UI | 384,28 KB (100 %) | ≈ 32 KB (**≈ 8 %**) | `vendor-react` y `vendor-supabase` (355,8 KB) siguen en caché |

**Justificación técnica:** el 92 % del bundle son `react-dom` y `supabase-js`, que la primera pantalla necesita sí o sí (el login requiere `auth-js`). Por eso la ganancia en el primer byte es modesta y se ha reportado tal cual. El beneficio grande está en:
- **(a)** sacar del camino crítico todo el código que no participa en el primer render (−72 % de código de la app);
- **(b)** la caché: con hashes de contenido, un despliegue normal solo obliga a descargar unos 32 KB en lugar de 384 KB;
- **(c)** `modulepreload` de los vendors, que se descargan en paralelo con el chunk de entrada.

### 4.4 Alternativas evaluadas y descartadas

| Propuesta de la IA | Medición / análisis | Decisión |
|---|---|---|
| `build.target: 'es2022'` | El CSS **subió** de 16,98 a 18,78 KB: el valor por defecto de Vite 8 (`baseline-widely-available`) ya es más moderno | Revertido |
| Sustituir `createClient` por `auth-js` + `postgrest-js` + `realtime-js` (ahorro ≈ 11,5 KB gz, ~10 %) | Obliga a reimplementar `fetchWithAuth`, `realtime.setAuth()` en cada renovación de token y la sincronización entre pestañas. Un fallo ahí hace que Realtime evalúe RLS como `anon` y deje de entregar eventos | Descartado: riesgo alto frente a una ganancia acotada. Revaluar si Supabase publica un cliente modular oficial |
| Tailwind escaneando `docs/*.html` (detectado al medir: CSS de 17,00 → 17,80 KB) | Los treemaps contienen texto que parece clases CSS | Corregido con `@source not "../docs"` |

---

## 5. Hardening de Supabase: variables de entorno y secretos

| Variable | Dónde vive | ¿Pública? | Comentario |
|---|---|---|---|
| `VITE_SUPABASE_URL` | `.env.local` (no versionado) | Sí | URL del proyecto |
| `VITE_SUPABASE_ANON_KEY` | `.env.local` (no versionado) | Sí | Clave **publishable**: no salta RLS; todo el control de acceso está en la base de datos |
| `service_role` / `sb_secret_…` | **Nunca en el frontend** | **No** | Salta RLS. Solo en servidores o Edge Functions |

**Controles aplicados:**
- **Un único punto de acceso al cliente:** solo `src/lib/` y `src/hooks/` importan Supabase. `grep -rn "supabase" src/components/` no devuelve resultados.
- **`.env.local` fuera de git:** está en `.gitignore` (`.env`, `.env.*`, salvo `.env.example`). `git ls-files` solo lista `.env.example`.
- **Guard en build** (`vite.config.ts`, plugin `taskmaster:forbid-secret-keys`): si alguna variable `VITE_*` contiene una `sb_secret_` o un JWT con `role: service_role`, el build se detiene. **Probado:**
  ```
  $ VITE_LEAK=sb_secret_abc123 npx vite build
  Error: Clave secreta de Supabase en variables públicas: VITE_LEAK. Usa solo la anon/publishable key en el frontend…
  ```
- **Comunicación mínima:**
  - CSP con `connect-src` limitado a `https://` y `wss://` del proyecto;
  - privilegios por columna (H2);
  - `anon` sin acceso a ninguna tabla.
- **Recomendado en el panel de Supabase (configuración, no código):**
  - longitud mínima de contraseña 8;
  - *Leaked password protection*;
  - *Confirm email* activado en producción;
  - revisar los *Rate limits* de Auth.

---

## 6. Verificación

| Comprobación | Resultado |
|---|---|
| `npm run build` | Sin errores ni warnings de TypeScript |
| `npm run lint` (oxlint) | 0 avisos |
| `npm test` (Vitest) | 11/11 en verde |
| `grep -rn ": any\|as any" src/` | Vacío |
| `grep -rn "supabase" src/components/` | Vacío |
| `dist/index.html` | CSP presente, 0 scripts inline |
| Guard de secretos | El build falla con `sb_secret_…` y con un JWT `service_role` |
| Migración `0003_security_hardening.sql` | **PENDIENTE:** ejecutar en Supabase (SQL Editor) y volver a probar con dos usuarios (crear, mover, comentar, invitar) |
