import { assertAuthorized, db, must } from '../lib/supabase';
import { TABLES } from '../lib/tables';

// GET /api/status  -> ringkasan topik, workflow, dan artikel untuk dashboard
export async function GET(req: Request) {
  const denied = assertAuthorized(req);
  if (denied) return denied;
  try {
    const topics = must(
      await db().from(TABLES.topics).select('id,title,status,priority,source,created_at').order('created_at', { ascending: false }).limit(20)
    );
    const workflows = must(
      await db().from(TABLES.workflows).select('id,topic_id,status,current_step,error_message,attempts,updated_at').order('created_at', { ascending: false }).limit(20)
    );
    const posts = must(
      await db().from(TABLES.posts).select('id,title,slug,status,word_count,meta_description,created_at').order('created_at', { ascending: false }).limit(30)
    );
    return Response.json({ topics, workflows, posts });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
