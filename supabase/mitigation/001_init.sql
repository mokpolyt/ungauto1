-- =====================================================================
-- AI Blog Orchestrator - Skema Database (Supabase / PostgreSQL)
-- Jalankan di: Supabase Dashboard > SQL Editor, atau `supabase db push`
-- =====================================================================

create extension if not exists "pgcrypto";

-- ---------- ENUM ----------
do $$ begin
  create type topic_status as enum ('queued', 'in_progress', 'done', 'failed', 'skipped');
exception when duplicate_object then null; end $$;

do $$ begin
  create type workflow_status as enum ('pending', 'researching', 'drafting', 'editing', 'completed', 'failed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type post_status as enum ('draft', 'ready', 'published', 'archived');
exception when duplicate_object then null; end $$;

-- ---------- Trigger updated_at ----------
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- =====================================================================
-- 1) topics_queuebcc8l : antrean topik (manual / auto-cron berita)
-- =====================================================================
create table if not exists topics_queuebcc8l (
  id             uuid primary key default gen_random_uuid(),
  title          text not null,
  source         text not null default 'manual',      -- manual | hackernews | rss:<domain>
  source_url     text unique,                         -- unique => anti-duplikat topik otomatis
  source_excerpt text,                                -- ringkasan/cuplikan sumber (grounding untuk Agen 1)
  priority       int  not null default 0,             -- makin besar makin duluan
  status         topic_status not null default 'queued',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists idx_topics_pick
  on topics_queuebcc8l (status, priority desc, created_at asc);

create trigger trg_topics_updated before update on topics_queuebcc8l
  for each row execute function set_updated_at();

-- =====================================================================
-- 2) agent_workflowsk3q9z : estafet antar agen + log mentah tiap agen
-- =====================================================================
create table if not exists agent_workflowsk3q9z (
  id               uuid primary key default gen_random_uuid(),
  topic_id         uuid not null references topics_queuebcc8l(id) on delete cascade,
  status           workflow_status not null default 'pending',
  current_step     text,                               -- langkah terakhir yang dijalankan (untuk debug)
  attempts         int  not null default 1,            -- naik tiap kali di-resume

  -- Output tiap agen (dipakai sebagai "estafet" ke agen berikutnya)
  research_output  jsonb,                              -- Agen 1: Laporan Riset (JSON)
  draft_markdown   text,                               -- Agen 2: Draf artikel (Markdown)

  -- Log teks mentah (audit & debugging prompt)
  agent1_raw       text,
  agent1_reasoning text,                               -- chain-of-thought deepseek-reasoner
  agent2_raw       text,
  agent3_raw       text,

  usage            jsonb not null default '{}'::jsonb, -- token usage per agen
  error_message    text,
  started_at       timestamptz not null default now(),
  completed_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists idx_workflows_status on agent_workflowsk3q9z (status, updated_at);
create index if not exists idx_workflows_topic  on agent_workflowsk3q9z (topic_id);

create trigger trg_workflows_updated before update on agent_workflowsk3q9z
  for each row execute function set_updated_at();

-- =====================================================================
-- 3) final_postshhty7u : artikel final siap publikasi
-- =====================================================================
create table if not exists final_postshhty7u (
  id               uuid primary key default gen_random_uuid(),
  workflow_id      uuid not null unique references agent_workflowsk3q9z(id) on delete cascade,
  topic_id         uuid references topics_queuebcc8l(id) on delete set null,
  title            text not null,
  slug             text not null unique,
  meta_title       text,
  meta_description text,
  content_markdown text not null,
  keywords         text[] not null default '{}',
  word_count       int,
  status           post_status not null default 'draft', -- default DRAFT: Anda review dulu sebelum publish
  published_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists idx_posts_status on final_postshhty7u (status, published_at desc);

create trigger trg_posts_updated before update on final_postshhty7u
  for each row execute function set_updated_at();

-- =====================================================================
-- Fungsi atomik: ambil 1 topik & kunci (aman dari eksekusi ganda)
-- =====================================================================
create or replace function claim_next_topic()
returns setof topics_queuebcc8l
language plpgsql as $$
declare
  t topics_queuebcc8l;
begin
  select * into t
  from topics_queuebcc8l
  where status = 'queued'
  order by priority desc, created_at asc
  for update skip locked
  limit 1;

  if not found then
    return;
  end if;

  update topics_queuebcc8l set status = 'in_progress' where id = t.id returning * into t;
  return next t;
end $$;

-- =====================================================================
-- Keamanan: aktifkan RLS tanpa policy => hanya service_role (backend) yang bisa akses.
-- Untuk dashboard publik/blog, tambahkan policy SELECT khusus final_postshhty7u berstatus 'published'.
-- =====================================================================
alter table topics_queuebcc8l    enable row level security;
alter table agent_workflowsk3q9z enable row level security;
alter table final_postshhty7u     enable row level security;

create policy "public can read published posts"
  on final_postshhty7u for select
  using (status = 'published');
