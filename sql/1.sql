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
  side text,
  "start" bigint,
  "end" bigint,
  duration bigint,
  "timestamp" bigint,
  "diaperType" text,
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
CREATE POLICY "Families strict policy" ON public.families
  FOR ALL USING (
    id::text = current_setting('request.headers', true)::json->>'x-family-id'
  ) WITH CHECK (
    id::text = current_setting('request.headers', true)::json->>'x-family-id'
  );

CREATE POLICY "Logs policy" ON public.logs 
  FOR ALL USING (
    family_id::text = current_setting('request.headers', true)::json->>'x-family-id'
  ) WITH CHECK (
    family_id::text = current_setting('request.headers', true)::json->>'x-family-id'
  );

CREATE POLICY "Timers policy" ON public.active_timers 
  FOR ALL USING (
    family_id::text = current_setting('request.headers', true)::json->>'x-family-id'
  ) WITH CHECK (
    family_id::text = current_setting('request.headers', true)::json->>'x-family-id'
  );