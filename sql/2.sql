-- FAMILIES : lecture/création libres (nécessaire pour créer une famille)
CREATE POLICY "anon_insert_families" ON public.families
  FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "anon_select_families" ON public.families
  FOR SELECT TO anon USING (true);

-- LOGS : toutes opérations autorisées si family_id existe bien dans families
CREATE POLICY "anon_all_logs" ON public.logs
  FOR ALL TO anon
  USING (family_id IN (SELECT id FROM public.families))
  WITH CHECK (family_id IN (SELECT id FROM public.families));

-- ACTIVE_TIMERS : idem
CREATE POLICY "anon_all_timers" ON public.active_timers
  FOR ALL TO anon
  USING (family_id IN (SELECT id FROM public.families))
  WITH CHECK (family_id IN (SELECT id FROM public.families));