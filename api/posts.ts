import { assertAuthorized, db, must } from '../lib/supabase';
import { TABLES } from '../lib/tables';

// GET   /api/posts?id=<uuid>             -> isi lengkap 1 artikel
// PATCH /api/posts  {id, status}          -> ubah status (draft | ready | published | archived)
export async function GET(req: Request) {
  const denied = assertAuthorized(req);
  if (denied) return denied;
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return Response.json({ error: 'id wajib' }, { status: 400 });
  try {
    const post = must(await db().from(TABLES.posts).select('*').eq('id', id).single());
    return Response.json({ post });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  const denied = assertAuthorized(req);
  if (denied) return denied;
  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: 'Body harus JSON' }, { status: 400 }); }
  const allowed = ['draft', 'ready', 'published', 'archived'];
  if (!body?.id || !allowed.includes(body.status)) {
    return Response.json({ error: 'id dan status valid wajib' }, { status: 400 });
  }
  try {
    must(
      await db()
        .from(TABLES.posts)
        .update({ status: body.status, published_at: body.status === 'published' ? new Date().toISOString() : null })
        .eq('id', body.id)
        .select('id')
    );
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
