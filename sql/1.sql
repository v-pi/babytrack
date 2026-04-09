-- Active l'extension pour générer des UUIDs sécurisés
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Table des familles
CREATE TABLE families (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at timestamptz DEFAULT now()
);

-- Table des logs
CREATE TABLE logs (
  id uuid PRIMARY KEY,
  family_id uuid REFERENCES families(id) ON DELETE CASCADE,
  type text NOT NULL,
  side text,
  "start" bigint,
  "end" bigint,
  duration bigint,
  "timestamp" bigint,
  "diaperType" text
);

-- Table des timers actifs
CREATE TABLE active_timers (
  family_id uuid REFERENCES families(id) ON DELETE CASCADE,
  type text NOT NULL,
  side text,
  start_time bigint NOT NULL,
  PRIMARY KEY (family_id, type, side)
);

-- ACTIVER LA SÉCURITÉ (RLS)
ALTER TABLE families ENABLE ROW LEVEL SECURITY;
ALTER TABLE logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE active_timers ENABLE ROW LEVEL SECURITY;

-- POLITIQUES DE SÉCURITÉ
-- 1. Autoriser la création d'une famille au premier lancement
CREATE POLICY "Famille creation" ON families FOR INSERT WITH CHECK (true);

-- 2. On isole tout le reste grâce au header x-family-id passé par le code Javascript
CREATE POLICY "Logs policy" ON logs FOR ALL USING (
  family_id::text = current_setting('request.headers', true)::json->>'x-family-id'
) WITH CHECK (
  family_id::text = current_setting('request.headers', true)::json->>'x-family-id'
);

CREATE POLICY "Timers policy" ON active_timers FOR ALL USING (
  family_id::text = current_setting('request.headers', true)::json->>'x-family-id'
) WITH CHECK (
  family_id::text = current_setting('request.headers', true)::json->>'x-family-id'
);