import { LEAD_CHUNK_SIZE, sleep, smartleadRequest } from "./client.js";
import { db } from "./supabase.js";

const CHUNK_DELAY_MS = 1500;

export type LeadImportRunSummary = {
  run_id: string;
  campaign_id: number;
  campaign_name: string | null;
  status: string;
  total_leads: number | null;
  imported_count: number;
  duplicate_count: number;
  invalid_count: number;
  error_message?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  created_at?: string | null;
};

type StagingLead = {
  id: string;
  campaign_id: number;
  campaign_name: string | null;
  email: string;
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
  location: string | null;
  local_sports_team: string | null;
};

type ChunkCounts = {
  imported: number;
  duplicate: number;
  invalid: number;
};

function num(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    typeof value === "string" &&
    value.trim() !== "" &&
    !Number.isNaN(Number(value))
  ) {
    return Number(value);
  }
  return 0;
}

/** Best-effort parse of Smartlead lead-import response counters. */
export function parseSmartleadImportCounts(
  response: unknown,
  chunkSize: number
): ChunkCounts {
  const root =
    response && typeof response === "object"
      ? ((response as Record<string, unknown>).data ?? response)
      : {};
  const obj =
    root && typeof root === "object"
      ? (root as Record<string, unknown>)
      : ({} as Record<string, unknown>);

  const duplicate =
    num(obj.duplicate_count) ||
    num(obj.duplicates_count) ||
    num(obj.duplicateLeads) ||
    num(obj.already_added) ||
    0;
  const invalid =
    num(obj.invalid_email_count) ||
    num(obj.invalid_count) ||
    num(obj.invalidEmails) ||
    num(obj.failed_count) ||
    0;
  const explicitImported =
    num(obj.upload_count) ||
    num(obj.imported_count) ||
    num(obj.added_count) ||
    num(obj.success_count) ||
    num(obj.new_leads) ||
    0;

  const imported =
    explicitImported > 0
      ? explicitImported
      : Math.max(0, chunkSize - duplicate - invalid);

  return { imported, duplicate, invalid };
}

function toSmartleadLead(row: StagingLead): Record<string, unknown> {
  const lead: Record<string, unknown> = {
    email: row.email,
  };
  if (row.first_name) lead.first_name = row.first_name;
  if (row.last_name) lead.last_name = row.last_name;
  if (row.company_name) lead.company_name = row.company_name;
  if (row.location) lead.location = row.location;

  const team = row.local_sports_team?.trim();
  if (team) {
    lead.custom_fields = { Local_Sports_Team: team };
  }
  return lead;
}

async function appendLog(runId: string, message: string): Promise<void> {
  const { error } = await db.insert("lead_import_logs", {
    run_id: runId,
    message,
  });
  if (error) {
    console.error("Failed to write lead_import_logs:", error.message);
  }
}

async function updateRun(
  runId: string,
  patch: Record<string, unknown>
): Promise<void> {
  const { error } = await db.update("lead_import_runs", `id=eq.${runId}`, patch);
  if (error) {
    throw new Error(`Failed to update lead_import_runs: ${error.message}`);
  }
}

async function fetchNextChunk(
  campaignId: number,
  limit: number
): Promise<StagingLead[]> {
  const { data, error } = await db.select<StagingLead[]>(
    "leads_staging",
    [
      "select=id,campaign_id,campaign_name,email,first_name,last_name,company_name,location,local_sports_team",
      `campaign_id=eq.${campaignId}`,
      "imported=eq.false",
      "order=created_at.asc",
      `limit=${limit}`,
    ].join("&")
  );
  if (error) {
    throw new Error(`Failed to fetch leads_staging: ${error.message}`);
  }
  return data || [];
}

async function markImported(ids: string[], runId: string): Promise<void> {
  if (ids.length === 0) return;
  const inList = `(${ids.join(",")})`;
  const { error } = await db.update("leads_staging", `id=in.${inList}`, {
    imported: true,
    import_run_id: runId,
  });
  if (error) {
    throw new Error(`Failed to mark leads imported: ${error.message}`);
  }
}

export async function startLeadImport(campaignId: number): Promise<{
  run_id: string;
  total_leads: number;
  campaign_name: string | null;
}> {
  const countRes = await db.countExact(
    "leads_staging",
    `campaign_id=eq.${campaignId}&imported=eq.false`
  );
  if (countRes.error) {
    throw new Error(`Failed to count staged leads: ${countRes.error.message}`);
  }

  const totalLeads = countRes.count ?? 0;
  if (totalLeads === 0) {
    throw new Error(
      `No unimported leads found in leads_staging for campaign_id ${campaignId}`
    );
  }

  const sampleRes = await db.select<Array<{ campaign_name: string | null }>>(
    "leads_staging",
    [
      "select=campaign_name",
      `campaign_id=eq.${campaignId}`,
      "imported=eq.false",
      "limit=1",
    ].join("&")
  );
  if (sampleRes.error) {
    throw new Error(
      `Failed to read staged campaign name: ${sampleRes.error.message}`
    );
  }
  const campaignName = sampleRes.data?.[0]?.campaign_name ?? null;

  const insertRes = await db.insert<Array<{ id: string }>>(
    "lead_import_runs",
    {
      campaign_id: campaignId,
      campaign_name: campaignName,
      status: "queued",
      total_leads: totalLeads,
      imported_count: 0,
      duplicate_count: 0,
      invalid_count: 0,
    },
    { returnRepresentation: true }
  );
  if (insertRes.error || !insertRes.data?.[0]?.id) {
    throw new Error(
      `Failed to create lead_import_runs row: ${insertRes.error?.message || "unknown"}`
    );
  }

  const runId = insertRes.data[0].id;
  await appendLog(
    runId,
    `Queued import for campaign ${campaignId} (${campaignName || "unnamed"}): ${totalLeads} unimported leads`
  );

  void processLeadImportRun(runId, campaignId).catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Lead import run ${runId} crashed:`, message);
    try {
      await updateRun(runId, {
        status: "failed",
        error_message: message,
        completed_at: new Date().toISOString(),
      });
      await appendLog(runId, `Run failed: ${message}`);
    } catch (updateError) {
      console.error("Failed to mark run failed:", updateError);
    }
  });

  return {
    run_id: runId,
    total_leads: totalLeads,
    campaign_name: campaignName,
  };
}

export async function processLeadImportRun(
  runId: string,
  campaignId: number
): Promise<void> {
  await updateRun(runId, {
    status: "running",
    started_at: new Date().toISOString(),
  });
  await appendLog(runId, "Import started");

  let importedTotal = 0;
  let duplicateTotal = 0;
  let invalidTotal = 0;
  let chunkIndex = 0;

  while (true) {
    const rows = await fetchNextChunk(campaignId, LEAD_CHUNK_SIZE);
    if (rows.length === 0) break;

    chunkIndex += 1;
    const leadList = rows.map(toSmartleadLead);

    await appendLog(
      runId,
      `Chunk ${chunkIndex}: uploading ${rows.length} leads to Smartlead`
    );

    try {
      const response = await smartleadRequest({
        method: "POST",
        path: `/campaigns/${campaignId}/leads`,
        body: { lead_list: leadList },
      });

      const counts = parseSmartleadImportCounts(response, rows.length);
      importedTotal += counts.imported;
      duplicateTotal += counts.duplicate;
      invalidTotal += counts.invalid;

      // Mark whole chunk processed so retries never re-send these rows.
      await markImported(
        rows.map((r) => r.id),
        runId
      );

      await updateRun(runId, {
        imported_count: importedTotal,
        duplicate_count: duplicateTotal,
        invalid_count: invalidTotal,
      });

      await appendLog(
        runId,
        `Chunk ${chunkIndex} ok: imported=${counts.imported}, duplicate=${counts.duplicate}, invalid=${counts.invalid} (running totals i=${importedTotal} d=${duplicateTotal} v=${invalidTotal})`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await appendLog(runId, `Chunk ${chunkIndex} failed: ${message}`);
      await updateRun(runId, {
        status: "failed",
        imported_count: importedTotal,
        duplicate_count: duplicateTotal,
        invalid_count: invalidTotal,
        error_message: message,
        completed_at: new Date().toISOString(),
      });
      return;
    }

    if (rows.length < LEAD_CHUNK_SIZE) break;
    await sleep(CHUNK_DELAY_MS);
  }

  await updateRun(runId, {
    status: "completed",
    imported_count: importedTotal,
    duplicate_count: duplicateTotal,
    invalid_count: invalidTotal,
    completed_at: new Date().toISOString(),
  });
  await appendLog(
    runId,
    `Import completed: imported=${importedTotal}, duplicate=${duplicateTotal}, invalid=${invalidTotal}`
  );
}

function summarizeRun(row: Record<string, unknown>): LeadImportRunSummary {
  return {
    run_id: String(row.id),
    campaign_id: Number(row.campaign_id),
    campaign_name: (row.campaign_name as string | null) ?? null,
    status: String(row.status),
    total_leads: row.total_leads == null ? null : Number(row.total_leads),
    imported_count: Number(row.imported_count || 0),
    duplicate_count: Number(row.duplicate_count || 0),
    invalid_count: Number(row.invalid_count || 0),
    error_message: (row.error_message as string | null) ?? null,
    started_at: (row.started_at as string | null) ?? null,
    completed_at: (row.completed_at as string | null) ?? null,
    created_at: (row.created_at as string | null) ?? null,
  };
}

export async function getLeadImportStatus(
  runId: string
): Promise<LeadImportRunSummary> {
  const { data, error } = await db.select<Record<string, unknown>[]>(
    "lead_import_runs",
    [
      "select=id,campaign_id,campaign_name,status,total_leads,imported_count,duplicate_count,invalid_count,error_message,started_at,completed_at,created_at",
      `id=eq.${runId}`,
      "limit=1",
    ].join("&")
  );
  if (error || !data?.[0]) {
    throw new Error(`Import run not found: ${runId}`);
  }
  return summarizeRun(data[0]);
}

export async function listLeadImportRuns(
  limit = 20
): Promise<LeadImportRunSummary[]> {
  const safeLimit = Math.min(Math.max(limit, 1), 100);
  const { data, error } = await db.select<Record<string, unknown>[]>(
    "lead_import_runs",
    [
      "select=id,campaign_id,campaign_name,status,total_leads,imported_count,duplicate_count,invalid_count,error_message,started_at,completed_at,created_at",
      "order=created_at.desc",
      `limit=${safeLimit}`,
    ].join("&")
  );
  if (error) {
    throw new Error(`Failed to list import runs: ${error.message}`);
  }
  return (data || []).map((row) => summarizeRun(row));
}
