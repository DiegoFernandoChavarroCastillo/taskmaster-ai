-- =============================================================================
-- TaskMaster AI · 0003_security_hardening.sql
-- Correcciones de la auditoría de seguridad (ver AUDITORIA.md).
-- Ejecutar DESPUÉS de 0001 y 0002. Es idempotente en lo posible.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- H3 · Funciones SECURITY DEFINER expuestas como RPC
--
-- PostgREST publica como endpoint /rest/v1/rpc/<fn> toda función del esquema
-- `public`. is_project_member(p_project_id, p_user_id) aceptaba CUALQUIER
-- usuario como segundo argumento y, al ejecutarse con privilegios del dueño
-- (saltándose RLS), funcionaba como un oráculo: "¿es X miembro de Y?".
--
-- Corrección: se mueven a un esquema `private` que la Data API no expone.
-- Las políticas RLS referencian las funciones por OID, así que siguen
-- funcionando sin recrearlas.
-- -----------------------------------------------------------------------------
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

alter function public.is_project_member(uuid, uuid) set schema private;
alter function public.is_project_owner(uuid)         set schema private;
alter function public.can_access_task(uuid)          set schema private;
alter function public.shares_project_with(uuid)      set schema private;

-- add_project_member_by_email SÍ debe seguir siendo RPC (la usa el cliente),
-- pero su cuerpo citaba public.is_project_owner por nombre: se recrea.
create or replace function public.add_project_member_by_email(p_project_id uuid, p_email text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  if not private.is_project_owner(p_project_id) then
    raise exception 'Solo el dueño del proyecto puede añadir miembros' using errcode = '42501';
  end if;

  select u.id into v_user_id
  from auth.users u
  where lower(u.email) = lower(btrim(p_email));

  if v_user_id is null then
    raise exception 'No existe ningún usuario con ese correo' using errcode = 'P0002';
  end if;

  insert into public.project_members (project_id, user_id)
  values (p_project_id, v_user_id)
  on conflict do nothing;

  return v_user_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- H1 · Comentarios "inyectables" en proyectos ajenos
--
-- La política de UPDATE solo comprobaba author_id. El autor podía hacer
--   update comments set task_id = '<tarea de otro proyecto>' where id = ...
-- y su texto aparecía (vía Realtime incluido) en un proyecto del que no es
-- miembro. Corrección doble: WITH CHECK revalida el acceso a la tarea
-- destino y, además, solo la columna `body` es actualizable (ver H2).
-- -----------------------------------------------------------------------------
drop policy if exists "comments_update_author" on public.comments;
create policy "comments_update_author" on public.comments
  for update to authenticated
  using (author_id = (select auth.uid()))
  with check (author_id = (select auth.uid()) and private.can_access_task(task_id));

-- -----------------------------------------------------------------------------
-- H2 · Asignación masiva de columnas (mass assignment)
--
-- `grant insert, update on tasks` permitía escribir CUALQUIER columna:
--  - updated_at = '2099-01-01' en el INSERT: el cliente aplica un UPDATE solo
--    si su updated_at es más reciente, así que todos los cambios posteriores
--    de esa tarea serían ignorados por el resto de usuarios (envenenamiento
--    del orden de Realtime);
--  - created_at arbitrario (falsear la cronología);
--  - project_id en el UPDATE (mover tareas entre proyectos).
--
-- Corrección: privilegios POR COLUMNA (lista blanca) + trigger que fija las
-- marcas de tiempo en el servidor como defensa en profundidad.
-- -----------------------------------------------------------------------------
revoke insert, update on public.tasks    from authenticated;
revoke insert, update on public.comments from authenticated;
revoke insert, update on public.projects from authenticated;
revoke update         on public.profiles from authenticated;

grant insert (project_id, title, description, status, priority, assignee_id) on public.tasks to authenticated;
grant update (title, description, status, priority, assignee_id)             on public.tasks to authenticated;
grant insert (task_id, author_id, body) on public.comments to authenticated;
grant update (body)                     on public.comments to authenticated;
grant insert (name, owner_id) on public.projects to authenticated;
grant update (name)           on public.projects to authenticated;
grant update (full_name, avatar_url) on public.profiles to authenticated;

create or replace function public.set_server_timestamps()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.created_at := now();
  if tg_table_name = 'tasks' then
    new.updated_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists tasks_set_server_timestamps on public.tasks;
create trigger tasks_set_server_timestamps
  before insert on public.tasks
  for each row execute function public.set_server_timestamps();

drop trigger if exists comments_set_server_timestamps on public.comments;
create trigger comments_set_server_timestamps
  before insert on public.comments
  for each row execute function public.set_server_timestamps();

-- -----------------------------------------------------------------------------
-- Endurecimiento adicional
-- -----------------------------------------------------------------------------

-- Perfiles: límites de longitud y solo URLs https en avatar_url (evita
-- `javascript:` si algún día se renderiza en un <img>/<a>).
alter table public.profiles
  drop constraint if exists profiles_full_name_length,
  add constraint profiles_full_name_length check (full_name is null or char_length(full_name) <= 100),
  drop constraint if exists profiles_avatar_url_https,
  add constraint profiles_avatar_url_https check (avatar_url is null or avatar_url ~ '^https://');

-- El trigger de registro recorta el nombre de los metadatos (controlados por
-- el usuario en signUp) para que no rompa la restricción anterior.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name, avatar_url)
  values (
    new.id,
    left(coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)), 100),
    case when new.raw_user_meta_data ->> 'avatar_url' ~ '^https://'
         then new.raw_user_meta_data ->> 'avatar_url' end
  );
  return new;
end;
$$;

-- `anon` no debe tocar ninguna tabla (sin sesión no hay acceso), tampoco en
-- tablas futuras.
revoke all on all tables in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;
