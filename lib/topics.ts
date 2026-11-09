import { assertAuthorized, db, must } from '../lib/supabase';
import { TABLES } from '../lib/tables';

// POST /api/topics   Header: Authorization: Bearer <CRON_SECRET>
// Body: { "title": "...", "source_url": "https://...", "source_excerpt": "...", "priority": 100 }
export async function POST(req: Request) {
  const denied = assertAuthorized(req);
  if (denied) return denied;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Body harus JSON' }, { status: 400 });
  }
  if (!body?.title || typeof body.title !== 'string') {
    return Response.json({ error: 'Field "title" wajib diisi' }, { status: 400 });
  }

  try {
    const topic = must(
      await db()
        .from(TABLES.topics)
        .insert({
          title: body.title.trim(),
          source: 'manual',
          source_url: body.source_url ?? null,
          source_excerpt: body.source_excerpt ?? null,
          priority: Number(body.priority ?? 100), // manual diprioritaskan di atas auto-topik
        })
        .select('id, title')
        .single()
    );
    return Response.json({ ok: true, topic }, { status: 201 });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
