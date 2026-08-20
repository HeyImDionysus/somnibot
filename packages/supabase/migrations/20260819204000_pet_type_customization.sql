ALTER TABLE public.guild_config
  ADD COLUMN IF NOT EXISTS economy_pet_type_config jsonb NOT NULL DEFAULT '{
    "hunting":{"name":"Hunting","emoji":"🐺","description":"Boosts hunt loot","price":5000},
    "guard":{"name":"Guard","emoji":"🐕","description":"Reduces rob success against you","price":5000},
    "foraging":{"name":"Foraging","emoji":"🐿️","description":"Passive item finds","price":5000},
    "lucky":{"name":"Lucky","emoji":"🐈","description":"Slight gambling boost","price":7500}
  }'::jsonb;

ALTER TABLE public.guild_config
  DROP CONSTRAINT IF EXISTS guild_config_pet_type_config_check;

ALTER TABLE public.guild_config
  ADD CONSTRAINT guild_config_pet_type_config_check CHECK (
    jsonb_typeof(economy_pet_type_config) = 'object'
    AND economy_pet_type_config ?& ARRAY['hunting', 'guard', 'foraging', 'lucky']
  );
