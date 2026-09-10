import { getHealthReport } from '@/lib/health';

/**
 * Liveness/readiness endpoint for the observability system itself.
 *
 * "The observability system must be observable" -- this is the entry point load
 * balancers and uptime checks use. It must never be cached.
 */

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const report = await getHealthReport();

  // `degraded` still serves traffic, so only a hard failure returns 503.
  const httpStatus = report.status === 'unhealthy' ? 503 : 200;

  return Response.json(report, {
    status: httpStatus,
    headers: { 'Cache-Control': 'no-store' },
  });
}
