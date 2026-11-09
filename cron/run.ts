import { assertAuthorized } from '../../lib/supabase';
import { ensureTopics } from '../../lib/topics';
import { runPipeline } from '../../lib/orchestrator';

// Dipanggil Vercel Cron (GET) tiap 3 hari: cari topik bila antrean tipis, lalu tulis 1 artikel.
export async function GET(req: Request) {
  const denied = assertAuthorized(req);
  if (denied) return denied;

  try {
    const discovery = await ensureTopics(3).catch((e) => ({ error: String(e) }));
    const result = await runPipeline();
    return Response.json({ discovery, result }, { status: result.ok ? 200 : 500 });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
