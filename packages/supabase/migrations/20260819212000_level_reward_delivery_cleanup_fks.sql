ALTER TABLE public.level_reward_deliveries
  DROP CONSTRAINT IF EXISTS level_reward_deliveries_reward_id_fkey,
  DROP CONSTRAINT IF EXISTS level_reward_deliveries_action_id_fkey;

ALTER TABLE public.level_reward_deliveries
  ADD CONSTRAINT level_reward_deliveries_reward_id_fkey
    FOREIGN KEY (reward_id)
    REFERENCES public.level_rewards(id)
    ON DELETE CASCADE,
  ADD CONSTRAINT level_reward_deliveries_action_id_fkey
    FOREIGN KEY (action_id)
    REFERENCES public.bot_action_queue(id)
    ON DELETE SET NULL;
