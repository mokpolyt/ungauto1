// =====================================================================
// ORCHESTRATOR — file utama yang mengatur estafet 3 agen.
//
// Alur:  topics_queue -> Agen 1 (riset) -> DB -> Agen 2 (draf) -> DB -> Agen 3 (editor) -> final_posts
//
// Prinsip:
//  - Setiap langkah menyimpan hasilnya ke DB, lalu langkah berikutnya MEMBACA dari DB.
//  - Setiap langkah idempoten: kalau output-nya sudah ada, langkah dilewati.
//    Jadi bila fungsi mati/timeout, `resumeStalled()` melanjutkan dari langkah terakhir (tanpa bayar ulang token).
//  - Error apa pun => workflow 'failed' + error_message tersimpan.
// =====================================================================

import { db, must } from './supabase';
import { TABLES } from './tables';
import { callDeepSeek, extractJson } from './deepseek';
import {
  researchSystem, researchUser,
  writerSystem, writerUser, writerExpandUser,
  editorSystem, editorUser,
  TopicInput,
} from './prompts';
import { fetchSourceText } from './topics';

const MAX_ATTEMPTS = 3;
const STALE_MS = 6 * 60 * 1000; // workflow tanpa update > 6 menit dianggap macet
const MIN_WORDS = 1100;
const MAX_TOKENS = Number(process.env.DEEPSEEK_MAX_TOKENS ?? 8192);

// ---------- Tipe ----------
type WorkflowStatus = 'pending' | 'researching' | 'drafting' | 'editing' | 'completed' | 'failed';

interface Topic extends TopicInput {
  id: string;
  status: string;
}

interface Workflow {
  id: string;
  topic_id: string;
  status: WorkflowStatus;
  attempts: number;
  research_output: any | null;
  draft_markdown: string | null;
  usage: Record<string, unknown> | null;
  updated_at: string;
}

export interface RunResult {
  ok: boolean;
  message?: string;
  workflowId?: string;
  postId?: string;
  slug?: string;
  error?: string;
}

// ---------- Helper DB ----------
const getWorkflow = async (id: string): Promise<Workflow> =>
  must(await db().from(TABLES.workflows).select('*').eq('id', id).single());

const getTopic = async (id: string): Promise<Topic> =>
  must(await db().from(TABLES.topics).select('*').eq('id', id).single());

async function setStatus(id: string, status: WorkflowStatus, extra: Record<string, unknown> = {}) {
  must(
    await db()
      .from(TABLES.workflows)
      .update({ status, current_step: status, ...extra })
      .eq('id', id)
      .select('id')
  );
}

async function setTopicStatus(id: string, status: 'queued' | 'in_progress' | 'done' | 'failed') {
  must(await db().from(TABLES.topics).update({ status }).eq('id', id).select('id'));
}

const countWords = (s: string) => s.split(/\s+/).filter(Boolean).length;

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70)
    .replace(/-+$/g, '');

async function uniqueSlug(base: string, workflowId: string): Promise<string> {
  const slug = slugify(base) || `artikel-${Date.now().toString(36)}`;
  const rows = must(
    await db().from(TABLES.posts).select('workflow_id').eq('slug', slug).limit(1)
  ) as { workflow_id: string }[];
  if (!rows.length || rows[0].workflow_id === workflowId) return slug;
  return `${slug}-${Date.now().toString(36).slice(-4)}`;
}

// =====================================================================
// LANGKAH 1 — Agen 1: Riset & Analisis (deepseek-reasoner)
// =====================================================================
async function stepResearch(workflowId: string): Promise<void> {
  const wf = await getWorkflow(workflowId);
  if (wf.research_output) return; // sudah selesai, lewati

  await setStatus(workflowId, 'researching');
  const topic = await getTopic(wf.topic_id);
  const sourceText = topic.source_url ? await fetchSourceText(topic.source_url) : '';

  const today = new Date().toISOString().slice(0, 10);
  const res = await callDeepSeek({
    model: 'deepseek-reasoner',
    system: researchSystem(today),
    user: researchUser(topic, sourceText),
    maxTokens: MAX_TOKENS,
  });

  const report = extractJson(res.content);
  if (!Array.isArray(report.key_facts) || !report.key_facts.length) {
    throw new Error('Laporan riset tidak valid: key_facts kosong');
  }

  must(
    await db()
      .from(TABLES.workflows)
      .update({
        research_output: report,
        agent1_raw: res.content,
        agent1_reasoning: res.reasoning,
        usage: { ...(wf.usage ?? {}), agent1: res.usage },
      })
      .eq('id', workflowId)
      .select('id')
  );
}

// =====================================================================
// LANGKAH 2 — Agen 2: Penulis (deepseek-chat)
// =====================================================================
async function stepDraft(workflowId: string): Promise<void> {
  const wf = await getWorkflow(workflowId); // baca ulang dari DB (estafet dari Agen 1)
  if (wf.draft_markdown) return;
  if (!wf.research_output) throw new Error('Estafet putus: research_output kosong');

  await setStatus(workflowId, 'drafting');

  let res = await callDeepSeek({
    model: 'deepseek-chat',
    system: writerSystem,
    user: writerUser(wf.research_output),
    temperature: 0.8,
    maxTokens: MAX_TOKENS,
  });
  let draft = res.content.trim();
  const usage: Record<string, unknown> = { ...(wf.usage ?? {}), agent2: res.usage };

  // Jaga-jaga: artikel terlalu pendek => satu kali perluasan
  const words = countWords(draft);
  if (words < MIN_WORDS) {
    res = await callDeepSeek({
      model: 'deepseek-chat',
      system: writerSystem,
      user: writerExpandUser(draft, words),
      temperature: 0.7,
      maxTokens: MAX_TOKENS,
    });
    draft = res.content.trim();
    usage.agent2_expand = res.usage;
  }

  if (countWords(draft) < 800) throw new Error(`Draf terlalu pendek (${countWords(draft)} kata)`);

  must(
    await db()
      .from(TABLES.workflows)
      .update({ draft_markdown: draft, agent2_raw: draft, usage })
      .eq('id', workflowId)
      .select('id')
  );
}

// =====================================================================
// LANGKAH 3 — Agen 3: Editor & SEO (deepseek-chat) -> final_posts
// =====================================================================
function parseEditorOutput(raw: string) {
  const metaMatch = raw.match(/<meta>([\s\S]*?)<\/meta>/i);
  const articleMatch = raw.match(/<article>([\s\S]*?)<\/article>/i);
  if (!metaMatch || !articleMatch) throw new Error('Format output Editor salah (blok <meta>/<article> tidak lengkap)');
  const meta = extractJson<{
    title?: string; meta_title?: string; meta_description?: string; slug?: string; keywords?: string[];
  }>(metaMatch[1]);
  return { meta, article: articleMatch[1].trim() };
}

async function stepEdit(workflowId: string): Promise<{ postId: string; slug: string }> {
  const wf = await getWorkflow(workflowId); // baca ulang dari DB (estafet dari Agen 2)
  if (!wf.draft_markdown) throw new Error('Estafet putus: draft_markdown kosong');

  await setStatus(workflowId, 'editing');

  const res = await callDeepSeek({
    model: 'deepseek-chat',
    system: editorSystem,
    user: editorUser(wf.draft_markdown, wf.research_output?.seo),
    temperature: 0.4,
    maxTokens: MAX_TOKENS,
  });

  const { meta, article } = parseEditorOutput(res.content);
  const h1 = article.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const title = (meta.title || h1 || '').trim();
  if (!title) throw new Error('Judul artikel tidak ditemukan');
  if (countWords(article) < 800) throw new Error('Artikel hasil editor terlalu pendek');

  const slug = await uniqueSlug(meta.slug || title, workflowId);

  const post = must(
    await db()
      .from(TABLES.posts)
      .upsert(
        {
          workflow_id: workflowId,
          topic_id: wf.topic_id,
          title,
          slug,
          meta_title: (meta.meta_title || title).slice(0, 70),
          meta_description: (meta.meta_description || '').slice(0, 170),
          content_markdown: article,
          keywords: (meta.keywords ?? []).slice(0, 10),
          word_count: countWords(article),
          status: 'draft', // sengaja 'draft': Anda review dulu sebelum publish
        },
        { onConflict: 'workflow_id' }
      )
      .select('id, slug')
      .single()
  ) as { id: string; slug: string };

  await setStatus(workflowId, 'completed', {
    agent3_raw: res.content,
    usage: { ...(wf.usage ?? {}), agent3: res.usage },
    completed_at: new Date().toISOString(),
    error_message: null,
  });
  await setTopicStatus(wf.topic_id, 'done');

  return { postId: post.id, slug: post.slug };
}

// =====================================================================
// RUNNER — menjalankan semua langkah + error handling
// =====================================================================
export async function runWorkflow(workflowId: string): Promise<RunResult> {
  try {
    await stepResearch(workflowId);
    await stepDraft(workflowId);
    const { postId, slug } = await stepEdit(workflowId);
    return { ok: true, workflowId, postId, slug };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[workflow ${workflowId}] GAGAL:`, message);
    try {
      await setStatus(workflowId, 'failed', { error_message: message.slice(0, 2000) });
      const wf = await getWorkflow(workflowId);
      await setTopicStatus(wf.topic_id, 'failed');
    } catch (dbErr) {
      console.error('Gagal menandai workflow sebagai failed:', dbErr);
    }
    return { ok: false, workflowId, error: message };
  }
}

/** Mulai workflow baru: ambil 1 topik dari antrean (atau topik tertentu) lalu jalankan. */
export async function runPipeline(topicId?: string): Promise<RunResult> {
  let topic: Topic | null = null;

  if (topicId) {
    topic = await getTopic(topicId);
    await setTopicStatus(topic.id, 'in_progress');
  } else {
    const rows = must(await db().rpc('claim_next_topic')) as Topic[] | null; // atomik, aman dari eksekusi ganda
    topic = rows?.[0] ?? null;
  }
  if (!topic) return { ok: true, message: 'Antrean topik kosong' };

  const wf = must(
    await db().from(TABLES.workflows).insert({ topic_id: topic.id, status: 'pending' }).select('id').single()
  ) as { id: string };

  return runWorkflow(wf.id);
}

/** Lanjutkan 1 workflow yang macet/gagal (maks MAX_ATTEMPTS percobaan). */
export async function resumeStalled(): Promise<RunResult> {
  const staleBefore = new Date(Date.now() - STALE_MS).toISOString();
  const candidates = must(
    await db()
      .from(TABLES.workflows)
      .select('id, attempts, updated_at')
      .in('status', ['pending', 'researching', 'drafting', 'editing', 'failed'])
      .lt('attempts', MAX_ATTEMPTS)
      .lt('updated_at', staleBefore)
      .order('updated_at', { ascending: true })
      .limit(1)
  ) as { id: string; attempts: number; updated_at: string }[];

  if (!candidates.length) return { ok: true, message: 'Tidak ada workflow yang perlu dilanjutkan' };
  const c = candidates[0];

  // Optimistic lock: hanya satu pemanggil yang berhasil "mengklaim" workflow ini.
  const claimed = must(
    await db()
      .from(TABLES.workflows)
      .update({ attempts: c.attempts + 1, error_message: null })
      .eq('id', c.id)
      .eq('updated_at', c.updated_at)
      .select('id, topic_id')
  ) as { id: string; topic_id: string }[];

  if (!claimed.length) return { ok: true, message: 'Workflow sudah diambil proses lain' };

  await setTopicStatus(claimed[0].topic_id, 'in_progress');
  return runWorkflow(c.id);
}
