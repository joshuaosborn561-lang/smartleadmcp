import { resolveApiKey, sleep } from "./client.js";
import { db } from "./supabase.js";

const BASE_URL = "https://server.smartlead.ai/api/v1";
const PAGE_LIMIT = 500;
const CONCURRENCY = 5;
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

export type LeadPurgeRunSummary = {
  run_id: string;
  campaign_id: number;
  campaign_name: string | null;
  status: string;
  total_leads: number | null;
  deleted_count: number;
  not_found_count: number;
  failed_count: number;
  error_message?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  created_at?: string | null;
};

type StagingPurgeRow = {
  id: string;
  email: string;
  campaign_name: string | null;
};

type DeleteOutcome = "deleted" | "not_found" | "failed";

async function updateRun(
  runId: string,
  patch: Record<string, unknown>
): Promise<void> {
  const { error } = await db.update("lead_purge_runs", `id=eq.${runId}`, patch);
  if (error) {
    throw new Error(`Failed to update lead_purge_runs: ${error.message}`);
  }
}

async function fetchPurgeSet(campaignId: number): Promise<StagingPurgeRow[]> {
  const rows: StagingPurgeRow[] = [];
  const pageSize = 1000;
  let offset = 0;

  while (true) {
    const { data, error } = await db.select<StagingPurgeRow[]>(
      "leads_staging",
      [
        "select=id,email,campaign_name",
        `campaign_id=eq.${campaignId}`,
        "purge=eq.true",
        "purged=eq.false",
        "order=created_at.asc",
        `limit=${pageSize}`,
        `offset=${offset}`,
      ].join("&")
    );
    if (error) {
      throw new Error(`Failed to fetch purge set: ${error.message}`);
    }
    const chunk = data || [];
    rows.push(...chunk);
    if (chunk.length < pageSize) break;
    offset += pageSize;
  }

  return rows;
}

async function markPurged(ids: string[], runId: string): Promise<void> {
  if (ids.length === 0) return;
  // PostgREST in.() batches — keep filter URLs reasonable.
  const BATCH = 100;
  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH);
    const inList = `(${slice.join(",")})`;
    const { error } = await db.update("leads_staging", `id=in.${inList}`, {
      purged: true,
      purge_run_id: runId,
    });
    if (error) {
      throw new Error(`Failed to mark leads purged: ${error.message}`);
    }
  }
}

/**
 * Build email (lowercased) → Smartlead lead.id map for the whole campaign.
 */
async function buildCampaignEmailLeadIdMap(
  campaignId: number
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  let offset = 0;

  while (true) {
    const apiKey = resolveApiKey();
    const url = new URL(`${BASE_URL}/campaigns/${campaignId}/leads`);
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("limit", String(PAGE_LIMIT));
    url.searchParams.set("offset", String(offset));

    let attempt = 0;
    let backoff = INITIAL_BACKOFF_MS;
    let payload: unknown;

    while (true) {
      const response = await fetch(url.toString(), { method: "GET" });
      if (response.status === 429 || response.status >= 500) {
        attempt += 1;
        if (attempt > MAX_RETRIES) {
          const text = await response.text();
          throw new Error(
            `Failed to list campaign leads after ${MAX_RETRIES} retries (${response.status}): ${text}`
          );
        }
        const retryAfterHeader = response.headers.get("retry-after");
        const retryAfterMs = retryAfterHeader
          ? Number(retryAfterHeader) * 1000
          : backoff;
        await sleep(Number.isFinite(retryAfterMs) ? retryAfterMs : backoff);
        backoff *= 2;
        continue;
      }
      const text = await response.text();
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = text;
      }
      if (!response.ok) {
        throw new Error(
          `GET /campaigns/${campaignId}/leads failed (${response.status}): ${
            typeof payload === "string" ? payload : JSON.stringify(payload)
          }`
        );
      }
      break;
    }

    const root =
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>)
        : {};
    const items = Array.isArray(root.data)
      ? root.data
      : Array.isArray(payload)
        ? payload
        : [];

    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const lead =
        row.lead && typeof row.lead === "object"
          ? (row.lead as Record<string, unknown>)
          : row;
      const email =
        typeof lead.email === "string" ? lead.email.trim().toLowerCase() : "";
      const idRaw = lead.id;
      const id =
        typeof idRaw === "number"
          ? idRaw
          : typeof idRaw === "string" && idRaw.trim() !== ""
            ? Number(idRaw)
            : NaN;
      if (email && Number.isFinite(id)) {
        map.set(email, id);
      }
    }

    if (items.length < PAGE_LIMIT) break;
    offset += PAGE_LIMIT;
  }

  return map;
}

async function deleteLeadWithRetry(
  campaignId: number,
  leadId: number
): Promise<{ ok: boolean; status: number; body: string }> {
  const apiKey = resolveApiKey();
  const url = `${BASE_URL}/campaigns/${campaignId}/leads/${leadId}?api_key=${encodeURIComponent(apiKey)}`;

  let attempt = 0;
  let backoff = INITIAL_BACKOFF_MS;

  while (true) {
    const response = await fetch(url, { method: "DELETE" });
    const body = await response.text();

    // Already gone — treat as successful purge for idempotency.
    if (response.status === 404) {
      return { ok: true, status: 404, body };
    }

    if (response.status === 429 || response.status >= 500) {
      attempt += 1;
      if (attempt > MAX_RETRIES) {
        return { ok: false, status: response.status, body };
      }
      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfterMs = retryAfterHeader
        ? Number(retryAfterHeader) * 1000
        : backoff;
      await sleep(Number.isFinite(retryAfterMs) ? retryAfterMs : backoff);
      backoff *= 2;
      continue;
    }

    if (!response.ok) {
      return { ok: false, status: response.status, body };
    }

    return { ok: true, status: response.status, body };
  }
}

async function mapPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  let next = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        await worker(items[index]);
      }
    }
  );
  await Promise.all(runners);
}

export async function startLeadPurge(campaignId: number): Promise<{
  run_id: string;
  total_leads: number;
  campaign_name: string | null;
}> {
  const purgeRows = await fetchPurgeSet(campaignId);
  const totalLeads = purgeRows.length;
  const campaignName = purgeRows[0]?.campaign_name ?? null;

  const insertRes = await db.insert<Array<{ id: string }>>(
    "lead_purge_runs",
    {
      campaign_id: campaignId,
      campaign_name: campaignName,
      status: totalLeads === 0 ? "completed" : "queued",
      total_leads: totalLeads,
      deleted_count: 0,
      not_found_count: 0,
      failed_count: 0,
      started_at: totalLeads === 0 ? new Date().toISOString() : null,
      completed_at: totalLeads === 0 ? new Date().toISOString() : null,
    },
    { returnRepresentation: true }
  );

  if (insertRes.error || !insertRes.data?.[0]?.id) {
    throw new Error(
      `Failed to create lead_purge_runs row: ${insertRes.error?.message || "unknown"}`
    );
  }

  const runId = insertRes.data[0].id;

  if (totalLeads === 0) {
    // Idempotent no-op when everything is already purged / nothing flagged.
    return { run_id: runId, total_leads: 0, campaign_name: campaignName };
  }

  console.log(
    `Lead purge ${runId}: queued campaign ${campaignId} (${campaignName || "unnamed"}) — ${totalLeads} staging rows`
  );

  void processLeadPurgeRun(runId, campaignId, purgeRows).catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Lead purge run ${runId} crashed:`, message);
    try {
      await updateRun(runId, {
        status: "failed",
        error_message: message,
        completed_at: new Date().toISOString(),
      });
    } catch (updateError) {
      console.error("Failed to mark purge run failed:", updateError);
    }
  });

  return {
    run_id: runId,
    total_leads: totalLeads,
    campaign_name: campaignName,
  };
}

export async function processLeadPurgeRun(
  runId: string,
  campaignId: number,
  purgeRows: StagingPurgeRow[]
): Promise<void> {
  await updateRun(runId, {
    status: "running",
    started_at: new Date().toISOString(),
  });

  const emailMap = await buildCampaignEmailLeadIdMap(campaignId);
  console.log(
    `Lead purge ${runId}: built campaign lead map size=${emailMap.size}; purge set size=${purgeRows.length}`
  );

  // Dedupe purge set by email (keep first staging id for marking).
  const byEmail = new Map<string, StagingPurgeRow>();
  for (const row of purgeRows) {
    const key = row.email.trim().toLowerCase();
    if (!key) continue;
    if (!byEmail.has(key)) byEmail.set(key, row);
  }

  let deletedCount = 0;
  let notFoundCount = 0;
  let failedCount = 0;
  const immediatelyPurgedIds: string[] = [];
  const deletedEmails = new Set<string>();
  const pendingWork: Array<{
    stagingId: string;
    email: string;
    leadId: number;
  }> = [];

  for (const [email, row] of byEmail) {
    const leadId = emailMap.get(email);
    if (leadId == null) {
      notFoundCount += 1;
      immediatelyPurgedIds.push(row.id);
      continue;
    }
    pendingWork.push({ stagingId: row.id, email, leadId });
  }

  // Mark not-found rows purged so re-runs skip them.
  await markPurged(immediatelyPurgedIds, runId);
  await updateRun(runId, {
    deleted_count: deletedCount,
    not_found_count: notFoundCount,
    failed_count: failedCount,
  });

  await mapPool(pendingWork, CONCURRENCY, async (item) => {
    const result = await deleteLeadWithRetry(campaignId, item.leadId);
    if (result.ok) {
      deletedCount += 1;
      deletedEmails.add(item.email);
      try {
        await markPurged([item.stagingId], runId);
      } catch (error) {
        console.error(
          `Lead purge ${runId}: deleted lead_id=${item.leadId} but failed to mark staging purged:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    } else {
      failedCount += 1;
      console.error(
        `Lead purge ${runId}: DELETE failed lead_id=${item.leadId} status=${result.status} body=${result.body.slice(0, 300)}`
      );
    }

    if ((deletedCount + failedCount) % 25 === 0) {
      try {
        await updateRun(runId, {
          deleted_count: deletedCount,
          not_found_count: notFoundCount,
          failed_count: failedCount,
        });
      } catch {
        // ignore transient counter update errors
      }
    }
  });

  // Mark any remaining duplicate staging rows for emails we deleted or that
  // were not found (same email, other staging ids still purge=true/purged=false).
  const stillOpen = await fetchPurgeSet(campaignId);
  const extraIds = stillOpen
    .filter((row) => {
      const key = row.email.trim().toLowerCase();
      return deletedEmails.has(key) || !emailMap.has(key);
    })
    .map((row) => row.id);
  await markPurged(extraIds, runId);

  const status =
    failedCount > 0 && deletedCount + notFoundCount === 0
      ? "failed"
      : "completed";

  await updateRun(runId, {
    status,
    deleted_count: deletedCount,
    not_found_count: notFoundCount,
    failed_count: failedCount,
    error_message:
      failedCount > 0
        ? `${failedCount} lead delete(s) failed after retries (see server logs for lead id + status)`
        : null,
    completed_at: new Date().toISOString(),
  });

  console.log(
    `Lead purge ${runId}: completed deleted=${deletedCount} not_found=${notFoundCount} failed=${failedCount}`
  );
}

function toSummary(row: Record<string, unknown>): LeadPurgeRunSummary {
  return {
    run_id: String(row.id),
    campaign_id: Number(row.campaign_id),
    campaign_name: (row.campaign_name as string | null) ?? null,
    status: String(row.status),
    total_leads: row.total_leads == null ? null : Number(row.total_leads),
    deleted_count: Number(row.deleted_count || 0),
    not_found_count: Number(row.not_found_count || 0),
    failed_count: Number(row.failed_count || 0),
    error_message: (row.error_message as string | null) ?? null,
    started_at: (row.started_at as string | null) ?? null,
    completed_at: (row.completed_at as string | null) ?? null,
    created_at: (row.created_at as string | null) ?? null,
  };
}

export async function getLeadPurgeStatus(
  runId: string
): Promise<LeadPurgeRunSummary> {
  const { data, error } = await db.select<Record<string, unknown>[]>(
    "lead_purge_runs",
    ["select=*", `id=eq.${runId}`, "limit=1"].join("&")
  );
  if (error) {
    throw new Error(`Failed to read lead_purge_runs: ${error.message}`);
  }
  if (!data?.[0]) {
    throw new Error(`lead_purge_runs row not found: ${runId}`);
  }
  return toSummary(data[0]);
}

export async function listLeadPurgeRuns(
  limit = 20
): Promise<LeadPurgeRunSummary[]> {
  const { data, error } = await db.select<Record<string, unknown>[]>(
    "lead_purge_runs",
    ["select=*", "order=created_at.desc", `limit=${limit}`].join("&")
  );
  if (error) {
    throw new Error(`Failed to list lead_purge_runs: ${error.message}`);
  }
  return (data || []).map(toSummary);
}
