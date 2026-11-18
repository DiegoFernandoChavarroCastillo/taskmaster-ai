-- =============================================================================
-- TaskMaster AI · 0001_taskmaster.sql
-- Esquema, índices, RLS basada en pertenencia al proyecto y Realtime.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Tipos enumerados
-- -----------------------------------------------------------------------------
create type public.task_status as enum ('pendiente', 'en_progreso', 'hecha');
create type public.task_priority as enum ('baja', 'media', 'alta');

-- -----------------------------------------------------------------------------
-- 2. Tablas
-- -----------------------------------------------------------------------------
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  full_name   text,
  avatar_url  text,
  created_at  timestamptz not null default now()
);

create table public.projects (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 1 and 120),
  owner_id    uuid not null references public.profiles (id) on delete cascade,
  created_at  timestamptz not null default now()
);

-- Tabla puente que resuelve la pertenencia usuario <-> proyecto.
create table public.project_members (
  project_id  uuid not null references public.projects (id) on delete cascade,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (project_id, user_id)
);

create table public.tasks (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects (id) on delete cascade,
  title        text not null check (char_length(btrim(title)) between 1 and 200),
  description  text,
  status       public.task_status   not null default 'pendiente',
  priority     public.task_priority not null default 'media',
  assignee_id  uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table public.comments (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references public.tasks (id) on delete cascade,
  author_id   uuid not null references public.profiles (id) on delete cascade,
  body        text not null check (char_length(btrim(body)) between 1 and 4000),
  created_at  timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- 3. Índices: todas las FK + (project_id, created_at)
--    Postgres NO indexa automáticamente las columnas FK. Sin estos índices,
--    los ON DELETE CASCADE y las comprobaciones RLS hacen seq scans.
-- -----------------------------------------------------------------------------
create index projects_owner_id_idx           on public.projects (owner_id);
create index project_members_project_id_idx  on public.project_members (project_id);
create index project_members_user_id_idx     on public.project_members (user_id);
create index tasks_project_id_idx            on public.tasks (project_id);
create index tasks_assignee_id_idx           on public.tasks (assignee_id);
-- Índice compuesto de la consulta principal del tablero:
--   where project_id = $1 order by created_at
create index tasks_project_id_created_at_idx on public.tasks (project_id, created_at);
create index comments_task_id_idx            on public.comments (task_id);
create index comments_author_id_idx          on public.comments (author_id);
create index comments_task_id_created_at_idx on public.comments (task_id, created_at);

-- -----------------------------------------------------------------------------
-- 4. Triggers
-- -----------------------------------------------------------------------------

-- updated_at lo fija SIEMPRE el servidor. El cliente lo usa para ordenar los
-- eventos de Realtime (un UPDATE solo se aplica si su updated_at es más
-- reciente que el de la fila en memoria), así que no puede depender del reloj
-- del navegador.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger tasks_set_updated_at
  before update on public.tasks
  for each row execute function public.set_updated_at();

-- Crea el perfil al registrarse un usuario en auth.users.
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
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)),
    new.raw_user_meta_data ->> 'avatar_url'
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- El dueño de un proyecto pasa a ser miembro automáticamente.
create or replace function public.add_owner_as_member()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.project_members (project_id, user_id)
  values (new.id, new.owner_id)
  on conflict do nothing;
  return new;
end;
$$;

create trigger projects_add_owner_as_member
  after insert on public.projects
  for each row execute function public.add_owner_as_member();

-- -----------------------------------------------------------------------------
-- 5. Funciones de pertenencia (SECURITY DEFINER)
--
-- Por qué SECURITY DEFINER: si la política de project_members consultara
-- project_members (o la de tasks consultara projects, cuya política consulta
-- project_members...), Postgres evaluaría RLS dentro de RLS y entraría en
-- "infinite recursion detected in policy". Estas funciones se ejecutan con los
-- privilegios de su dueño, por lo que leen project_members SIN aplicar RLS y
-- cortan la recursión.
--
-- Por qué set search_path = '': una función SECURITY DEFINER con search_path
-- mutable permite que un atacante cree objetos homónimos en un esquema que
-- aparezca antes en la ruta y secuestre la ejecución con privilegios elevados.
-- Con search_path vacío, todo debe ir cualificado (public., auth.).
-- -----------------------------------------------------------------------------
create or replace function public.is_project_member(
  p_project_id uuid,
  p_user_id    uuid default auth.uid()
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.project_members pm
    where pm.project_id = p_project_id
      and pm.user_id    = p_user_id
  );
$$;

create or replace function public.is_project_owner(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.projects p
    where p.id = p_project_id
      and p.owner_id = auth.uid()
  );
$$;

create or replace function public.can_access_task(p_task_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.tasks t
    join public.project_members pm on pm.project_id = t.project_id
    where t.id = p_task_id
      and pm.user_id = auth.uid()
  );
$$;

-- Dos usuarios "se ven" si comparten al menos un proyecto.
create or replace function public.shares_project_with(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.project_members mine
    join public.project_members theirs on theirs.project_id = mine.project_id
    where mine.user_id   = auth.uid()
      and theirs.user_id = p_user_id
  );
$$;

-- Invitación por correo: solo el dueño puede añadir miembros. Necesita
-- SECURITY DEFINER para leer auth.users, que no es accesible desde el cliente.
create or replace function public.add_project_member_by_email(p_project_id uuid, p_email text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  if not public.is_project_owner(p_project_id) then
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

revoke execute on function public.add_project_member_by_email(uuid, text) from public, anon;
grant  execute on function public.add_project_member_by_email(uuid, text) to authenticated;

revoke execute on function public.is_project_member(uuid, uuid) from public, anon;
revoke execute on function public.is_project_owner(uuid)         from public, anon;
revoke execute on function public.can_access_task(uuid)          from public, anon;
revoke execute on function public.shares_project_with(uuid)      from public, anon;
grant  execute on function public.is_project_member(uuid, uuid) to authenticated;
grant  execute on function public.is_project_owner(uuid)         to authenticated;
grant  execute on function public.can_access_task(uuid)          to authenticated;
grant  execute on function public.shares_project_with(uuid)      to authenticated;

-- -----------------------------------------------------------------------------
-- 6. Row Level Security
--    (select auth.uid()) se envuelve en un subselect para que Postgres lo
--    evalúe una vez por consulta (initPlan) y no una vez por fila.
-- -----------------------------------------------------------------------------
alter table public.profiles        enable row level security;
alter table public.projects        enable row level security;
alter table public.project_members enable row level security;
alter table public.tasks           enable row level security;
alter table public.comments        enable row level security;

-- profiles ---------------------------------------------------------------------
create policy "profiles_select_self_or_teammates" on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or public.shares_project_with(id));

create policy "profiles_update_self" on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- projects ---------------------------------------------------------------------
-- owner_id = auth.uid() permite el RETURNING del insert antes de que el
-- trigger add_owner_as_member sea visible.
create policy "projects_select_members" on public.projects
  for select to authenticated
  using (owner_id = (select auth.uid()) or public.is_project_member(id));

create policy "projects_insert_owner" on public.projects
  for insert to authenticated
  with check (owner_id = (select auth.uid()));

create policy "projects_update_owner" on public.projects
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy "projects_delete_owner" on public.projects
  for delete to authenticated
  using (owner_id = (select auth.uid()));

-- project_members --------------------------------------------------------------
create policy "members_select_same_project" on public.project_members
  for select to authenticated
  using (public.is_project_member(project_id));

create policy "members_insert_by_owner" on public.project_members
  for insert to authenticated
  with check (public.is_project_owner(project_id));

create policy "members_delete_owner_or_self" on public.project_members
  for delete to authenticated
  using (public.is_project_owner(project_id) or user_id = (select auth.uid()));

-- tasks: solo miembros del proyecto ven y modifican sus tareas -----------------
create policy "tasks_select_members" on public.tasks
  for select to authenticated
  using (public.is_project_member(project_id));

create policy "tasks_insert_members" on public.tasks
  for insert to authenticated
  with check (
    public.is_project_member(project_id)
    and (assignee_id is null or public.is_project_member(project_id, assignee_id))
  );

-- with check impide "mover" una tarea a un proyecto ajeno o asignarla a
-- alguien que no es miembro.
create policy "tasks_update_members" on public.tasks
  for update to authenticated
  using (public.is_project_member(project_id))
  with check (
    public.is_project_member(project_id)
    and (assignee_id is null or public.is_project_member(project_id, assignee_id))
  );

create policy "tasks_delete_members" on public.tasks
  for delete to authenticated
  using (public.is_project_member(project_id));

-- comments ---------------------------------------------------------------------
create policy "comments_select_members" on public.comments
  for select to authenticated
  using (public.can_access_task(task_id));

create policy "comments_insert_members" on public.comments
  for insert to authenticated
  with check (author_id = (select auth.uid()) and public.can_access_task(task_id));

create policy "comments_update_author" on public.comments
  for update to authenticated
  using (author_id = (select auth.uid()))
  with check (author_id = (select auth.uid()));

create policy "comments_delete_author" on public.comments
  for delete to authenticated
  using (author_id = (select auth.uid()));

-- -----------------------------------------------------------------------------
-- 7. Realtime
-- -----------------------------------------------------------------------------
alter publication supabase_realtime add table public.tasks;
alter publication supabase_realtime add table public.comments;
alter publication supabase_realtime add table public.project_members;

-- REPLICA IDENTITY FULL
-- Por defecto (REPLICA IDENTITY DEFAULT) Postgres solo escribe en el WAL la
-- clave primaria de la fila antigua. Como Realtime lee el WAL, SIN REPLICA
-- IDENTITY FULL el evento DELETE solo trae la clave primaria (payload.old =
-- { id }) y los UPDATE no traen los valores previos: no se puede saber a qué
-- project_id pertenecía la fila borrada ni evaluar filtros sobre ella.
-- Con FULL, el WAL guarda la fila antigua completa.
--
-- Matiz importante de Supabase: como Postgres no puede comprobar RLS sobre una
-- fila que ya no existe, en tablas con RLS activa Realtime recorta igualmente
-- payload.old de los DELETE a la clave primaria (para no filtrar datos). Por
-- eso el cliente (hooks/useRealtimeList.ts) elimina las filas SOLO por id y
-- escucha los DELETE sin filtro de project_id: borrar un id que no está en
-- memoria es una operación nula.
alter table public.tasks    replica identity full;
alter table public.comments replica identity full;
