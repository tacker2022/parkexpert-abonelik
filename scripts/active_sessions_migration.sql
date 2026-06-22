-- 1. Create active_sessions table
create table active_sessions (
  id text primary key, -- Stores JWT JTI claim (unique per token session)
  username text not null,
  name text not null,
  role text not null,
  ip_address text,
  user_agent text,
  created_at timestamp with time zone default now(),
  last_active_at timestamp with time zone default now()
);

-- 2. Enable Row Level Security (RLS)
alter table active_sessions enable row level security;

-- 3. Since our backend uses SERVICE_ROLE_KEY to bypass RLS, we do not need to create any policies.
-- Having no policies ensures that anyone attempting to read this table using the public anon_key will be completely blocked.
