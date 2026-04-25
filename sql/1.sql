-- ==============================================================================
-- BABYTRACK - FULL DATABASE SCHEMA & SECURITY
-- ==============================================================================

-- 1. EXTENSIONS
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. TABLES
CREATE TABLE IF NOT EXISTS public.families (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at timestamptz DEFAULT now(),
  baby_name text CONSTRAINT baby_name_length CHECK (length(baby_name) < 100),
  baby_emoji text CONSTRAINT baby_emoji_length CHECK (length(baby_emoji) < 20)
);

CREATE TABLE IF NOT EXISTS public.logs (
  id uuid PRIMARY KEY,
  family_id uuid REFERENCES public.families(id) ON DELETE CASCADE,
  type text NOT NULL CONSTRAINT type_length CHECK (length(type) < 50),
  side text CONSTRAINT side_length CHECK (length(side) < 20),
  "start" bigint,
  "end" bigint,
  duration bigint,
  "timestamp" bigint,
  "diaperType" text CONSTRAINT diaper_type_length CHECK (length("diaperType") < 20),
  volume integer,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.active_timers (
  family_id uuid REFERENCES public.families(id) ON DELETE CASCADE,
  type text NOT NULL,
  side text,
  start_time bigint NOT NULL,
  paused boolean DEFAULT false,
  accumulated bigint DEFAULT 0,
  PRIMARY KEY (family_id, type, side)
);

-- 3. INDEX DE PERFORMANCE
-- Indispensable pour éviter un "full table scan" lors de la synchro d'une famille
CREATE INDEX IF NOT EXISTS idx_logs_family_id ON public.logs (family_id);

-- 4. SÉCURITÉ (RLS - ROW LEVEL SECURITY)
-- Activation de la sécurité sur toutes les tables
ALTER TABLE public.families ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.active_timers ENABLE ROW LEVEL SECURITY;

-- 5. POLITIQUES STRICTES (Basées sur le header x-family-id)
-- Autorise toutes les opérations (SELECT, INSERT, UPDATE, DELETE) 
-- UNIQUEMENT SI le code JS envoie le bon header HTTP
CREATE POLICY "Families policy" ON public.families
  FOR ALL USING (
    id::text = current_setting('request.headers', true)::json->>'x-family-id'
    OR id::text = auth.jwt()->'user_metadata'->>'family_id'
  ) WITH CHECK (
    id::text = current_setting('request.headers', true)::json->>'x-family-id'
    OR id::text = auth.jwt()->'user_metadata'->>'family_id'
  );

CREATE POLICY "Logs policy" ON public.logs 
  FOR ALL USING (
    family_id::text = current_setting('request.headers', true)::json->>'x-family-id'
    OR family_id::text = auth.jwt()->'user_metadata'->>'family_id'
  ) WITH CHECK (
    family_id::text = current_setting('request.headers', true)::json->>'x-family-id'
    OR family_id::text = auth.jwt()->'user_metadata'->>'family_id'
  );

CREATE POLICY "Timers policy" ON public.active_timers 
  FOR ALL USING (
    family_id::text = current_setting('request.headers', true)::json->>'x-family-id'
    OR family_id::text = auth.jwt()->'user_metadata'->>'family_id'
  ) WITH CHECK (
    family_id::text = current_setting('request.headers', true)::json->>'x-family-id'
    OR family_id::text = auth.jwt()->'user_metadata'->>'family_id'
  );
  
  
 
CREATE TABLE IF NOT EXISTS public.invite_codes (
  code       text        PRIMARY KEY,                          -- 7-char e.g. "MJKNPQ4"
  family_id  uuid        NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  expires_at timestamptz NOT NULL
);

-- Index for the SELECT lookup (code + expiry check)
CREATE INDEX IF NOT EXISTS idx_invite_codes_lookup
  ON public.invite_codes (code, expires_at);

-- RLS
ALTER TABLE public.invite_codes ENABLE ROW LEVEL SECURITY;

-- INSERT: only for your own family
CREATE POLICY "invite_codes_insert" ON public.invite_codes
  FOR INSERT WITH CHECK (family_id::text = auth.jwt()->'user_metadata'->>'family_id');

-- SELECT: only if caller sends the exact code as x-invite-code header + not expired.
-- Without this header a full table scan returns 0 rows — no enumeration possible.
CREATE POLICY "invite_codes_select" ON public.invite_codes
  FOR SELECT USING (
    code = current_setting('request.headers', true)::json->>'x-invite-code'
    AND expires_at > now()
  );

-- Rate-limit invite code creation the same way as logs/timers.
-- DELETE is already exempt from the ban logic (see 3_fix_delete_trigger.sql).
CREATE TRIGGER shadow_ban_invite_codes_trigger
BEFORE INSERT OR UPDATE OR DELETE ON public.invite_codes
FOR EACH ROW EXECUTE FUNCTION public.check_and_apply_shadow_ban();

ALTER POLICY "Families policy" ON public.families TO authenticated;
ALTER POLICY "Logs policy" ON public.logs TO authenticated;
ALTER POLICY "Timers policy" ON public.active_timers TO authenticated;
ALTER POLICY "invite_codes_insert" ON public.invite_codes TO authenticated;
ALTER POLICY "invite_codes_select" ON public.invite_codes TO authenticated;


ALTER PUBLICATION supabase_realtime ADD TABLE public.families;
ALTER PUBLICATION supabase_realtime ADD TABLE public.logs;
ALTER PUBLICATION supabase_realtime ADD TABLE public.active_timers;