-- 1. On supprime les politiques dangereuses (2.sql et 3.sql)
DROP POLICY IF EXISTS "anon_all_logs" ON public.logs;
DROP POLICY IF EXISTS "anon_all_timers" ON public.active_timers;
DROP POLICY IF EXISTS "anon_insert_families" ON public.families;
DROP POLICY IF EXISTS "anon_select_families" ON public.families;
DROP POLICY IF EXISTS "anon_update_families" ON public.families;

-- 2. On s'assure que RLS est actif partout
ALTER TABLE families ENABLE ROW LEVEL SECURITY;

-- 3. On crée la sécurité stricte basée sur le header "x-family-id"
-- (On suppose que les politiques "Logs policy" et "Timers policy" de 1.sql existent déjà, 
-- sinon tu peux les recréer ici)

-- Politique pour FAMILIES (Création, Lecture, Mise à jour)
CREATE POLICY "Families strict policy" ON public.families
  FOR ALL USING (
    id::text = current_setting('request.headers', true)::json->>'x-family-id'
  ) WITH CHECK (
    id::text = current_setting('request.headers', true)::json->>'x-family-id'
  );