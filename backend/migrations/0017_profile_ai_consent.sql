-- Never infer consent from an existing profile, publication flag or group membership.
ALTER TABLE personal_profiles ADD COLUMN ai_use_allowed INTEGER NOT NULL DEFAULT 0 CHECK(ai_use_allowed IN (0,1));
