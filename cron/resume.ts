import { assertAuthorized } from '../../lib/supabase';
import { resumeStalled } from '../../lib/orchestrator';

// Jaring pengaman harian: melanjutkan workflow yang timeout/gagal dari langkah terakhir yang tersimpan.
export async function GET(req: Request) {
  const denied = assertAuthorized(req);
  if (denied) return denied;

  try {
    const result = await resumeStalled();
    return Response.json(result, { status: result.ok ? 200 : 500 });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
