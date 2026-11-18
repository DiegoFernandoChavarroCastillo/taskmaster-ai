-- =============================================================================
-- TaskMaster AI · 0002_grants.sql
-- Privilegios explícitos para el rol `authenticated`.
--
-- Los proyectos nuevos de Supabase ya no conceden automáticamente privilegios
-- sobre las tablas de `public` a los roles de la Data API. Sin estos GRANT,
-- PostgREST responde "permission denied for table ..." (42501) antes incluso
-- de evaluar RLS. Los GRANT abren la puerta; las políticas RLS de 0001 siguen
-- decidiendo qué filas puede ver y modificar cada usuario.
--
-- `anon` no recibe ningún privilegio: sin sesión no se accede a nada.
-- =============================================================================

grant usage on schema public to authenticated;

grant select, update               on public.profiles        to authenticated;
grant select, insert, update, delete on public.projects        to authenticated;
grant select, insert, delete       on public.project_members to authenticated;
grant select, insert, update, delete on public.tasks           to authenticated;
grant select, insert, update, delete on public.comments        to authenticated;
