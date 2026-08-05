import { csvToLeadRows, type CsvLeadRow } from "./csv.js";
import { startLeadImport } from "./leadImportJob.js";
import { sleep } from "./client.js";
import { db } from "./supabase.js";

/** Safe insert size confirmed in-session (~500). Stay under that. */
const STAGE_CHUNK_SIZE = 400;
const STAGE_CHUNK_DELAY_MS = 250;

export type LeadStageRunSummary = {
  run_id: string;
  campaign_id: number;
  campaign_name: string | null;
  source_url: string | null;
  status: string;
  total_rows: number | null;
  staged_count: number;
  skipped_count: number;
  chunk_count: number;
  auto_import: boolean;
  import_run_id: string | null;
  error_message?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  created_at?: string | null;
};

async function appendLog(runId: string, message: string): Promise<void> {
  const { error } = await db.insert("lead_stage_logs", {
    run_id: runId,
    message,
  });
  if (error) {
    console.error("Failed to write lead_stage_logs:", error.message);
  }
}

async function updateRun(
  runId: string,
  patch: Record<string, unknown>
): Promise<void> {
  const { error } = await db.update("lead_stage_runs", `id=eq.${runId}`, patch);
  if (error) {
    throw new Error(`Failed to update lead_stage_runs: ${error.message}`);
  }
}

async function fetchCsvText(source: {
  csv_url?: string;
  payload_name?: string;
}): Promise<{ text: string; label: string }> {
  if (source.csv_url) {
    const response = await fetch(source.csv_url, {
      headers: {
        Accept: "text/csv,text/plain,*/*",
        "User-Agent": "smartlead-mcp-stage-leads/1.0",
      },
      redirect: "follow",
    });
    if (!response.ok) {
      throw new Error(
        `Failed to download CSV (${response.status}): ${source.csv_url}`
      );
    }
    return { text: await response.text(), label: source.csv_url };
  }

  if (source.payload_name) {
    const quoted = `"${source.payload_name.replace(/"/g, '\\"')}"`;
    const { data, error } = await db.select<Array<{ content: string }>>(
      "csv_payloads",
      [
        "select=content",
        `name=eq.${encodeURIComponent(quoted)}`,
        "limit=1",
      ].join("&")
    );
    if (error) {
      throw new Error(`Failed to read csv_payloads: ${error.message}`);
    }
    if (!data?.[0]?.content) {
      throw new Error(
        `No csv_payloads row found with name="${source.payload_name}"`
      );
    }
    return {
      text: data[0].content,
      label: `csv_payloads:${source.payload_name}`,
    };
  }

  throw new Error("Provide csv_url or payload_name");
}

function toStagingRow(
  row: CsvLeadRow,
  campaignId: number,
  campaignName: string
): Record<string, unknown> {
  return {
    campaign_id: campaignId,
    campaign_name: campaignName,
    email: row.email,
    first_name: row.first_name ?? null,
    last_name: row.last_name ?? null,
    company_name: row.company_name ?? null,
    location: row.location ?? null,
    local_sports_team: row.local_sports_team ?? null,
    imported: false,
  };
}

export async function startLeadStaging(options: {
  campaign_id: number;
  campaign_name: string;
  csv_url?: string;
  payload_name?: string;
  auto_import?: boolean;
}): Promise<{
  run_id: string;
  campaign_id: number;
  campaign_name: string;
  auto_import: boolean;
  source: string;
}> {
  if (!options.csv_url && !options.payload_name) {
    throw new Error("Provide csv_url or payload_name");
  }

  const autoImport = Boolean(options.auto_import);
  const sourceLabel = options.csv_url || `csv_payloads:${options.payload_name}`;

  const insertRes = await db.insert<Array<{ id: string }>>(
    "lead_stage_runs",
    {
      campaign_id: options.campaign_id,
      campaign_name: options.campaign_name,
      source_url: options.csv_url || null,
      status: "queued",
      staged_count: 0,
      skipped_count: 0,
      chunk_count: 0,
      auto_import: autoImport,
    },
    { returnRepresentation: true }
  );

  if (insertRes.error || !insertRes.data?.[0]?.id) {
    throw new Error(
      `Failed to create lead_stage_runs row: ${insertRes.error?.message || "unknown"}`
    );
  }

  const runId = insertRes.data[0].id;
  await appendLog(
    runId,
    `Queued staging for campaign ${options.campaign_id} (${options.campaign_name}) from ${sourceLabel}; auto_import=${autoImport}`
  );

  void processLeadStageRun(runId, {
    campaign_id: options.campaign_id,
    campaign_name: options.campaign_name,
    csv_url: options.csv_url,
    payload_name: options.payload_name,
    auto_import: autoImport,
  }).catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Lead stage run ${runId} crashed:`, message);
    try {
      await updateRun(runId, {
        status: "failed",
        error_message: message,
        completed_at: new Date().toISOString(),
      });
      await appendLog(runId, `Run failed: ${message}`);
    } catch (updateError) {
      console.error("Failed to mark stage run failed:", updateError);
    }
  });

  return {
    run_id: runId,
    campaign_id: options.campaign_id,
    campaign_name: options.campaign_name,
    auto_import: autoImport,
    source: sourceLabel || "unknown",
  };
}

export async function processLeadStageRun(
  runId: string,
  options: {
    campaign_id: number;
    campaign_name: string;
    csv_url?: string;
    payload_name?: string;
    auto_import: boolean;
  }
): Promise<void> {
  await updateRun(runId, {
    status: "running",
    started_at: new Date().toISOString(),
  });
  await appendLog(runId, "Staging started — downloading/reading CSV");

  const { text, label } = await fetchCsvText(options);
  await appendLog(
    runId,
    `Loaded source ${label} (${text.length.toLocaleString()} chars)`
  );

  const parsed = csvToLeadRows(text);
  await updateRun(runId, {
    total_rows: parsed.total_data_rows,
    skipped_count: parsed.skipped,
  });
  await appendLog(
    runId,
    `Parsed ${parsed.rows.length} valid leads (${parsed.skipped} skipped of ${parsed.total_data_rows} data rows)`
  );

  if (parsed.rows.length === 0) {
    await updateRun(runId, {
      status: "failed",
      error_message: "No valid email rows found in CSV",
      completed_at: new Date().toISOString(),
    });
    await appendLog(runId, "Failed: no valid email rows");
    return;
  }

  let staged = 0;
  let chunks = 0;

  for (let i = 0; i < parsed.rows.length; i += STAGE_CHUNK_SIZE) {
    const slice = parsed.rows.slice(i, i + STAGE_CHUNK_SIZE);
    const payload = slice.map((row) =>
      toStagingRow(row, options.campaign_id, options.campaign_name)
    );

    chunks += 1;
    const { error } = await db.insert("leads_staging", payload);
    if (error) {
      const message = `Chunk ${chunks} insert failed (${payload.length} rows): ${error.message}`;
      await appendLog(runId, message);
      await updateRun(runId, {
        status: "failed",
        staged_count: staged,
        chunk_count: chunks,
        skipped_count: parsed.skipped,
        error_message: message,
        completed_at: new Date().toISOString(),
      });
      return;
    }

    staged += payload.length;
    await updateRun(runId, {
      staged_count: staged,
      chunk_count: chunks,
    });
    await appendLog(
      runId,
      `Chunk ${chunks}: staged ${payload.length} rows (total staged=${staged}/${parsed.rows.length})`
    );

    if (i + STAGE_CHUNK_SIZE < parsed.rows.length) {
      await sleep(STAGE_CHUNK_DELAY_MS);
    }
  }

  await appendLog(
    runId,
    `Staging completed: staged=${staged}, skipped=${parsed.skipped}, chunks=${chunks}`
  );

  let importRunId: string | null = null;
  if (options.auto_import) {
    await appendLog(runId, "auto_import=true — starting Smartlead import job");
    try {
      const started = await startLeadImport(options.campaign_id);
      importRunId = started.run_id;
      await updateRun(runId, { import_run_id: importRunId });
      await appendLog(
        runId,
        `Import queued: import_run_id=${importRunId}, total_leads=${started.total_leads}`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await updateRun(runId, {
        status: "failed",
        staged_count: staged,
        chunk_count: chunks,
        skipped_count: parsed.skipped,
        error_message: `Staging succeeded but import failed to start: ${message}`,
        completed_at: new Date().toISOString(),
      });
      await appendLog(runId, `Import start failed: ${message}`);
      return;
    }
  }

  await updateRun(runId, {
    status: "completed",
    staged_count: staged,
    chunk_count: chunks,
    skipped_count: parsed.skipped,
    import_run_id: importRunId,
    completed_at: new Date().toISOString(),
  });
}

function summarize(row: Record<string, unknown>): LeadStageRunSummary {
  return {
    run_id: String(row.id),
    campaign_id: Number(row.campaign_id),
    campaign_name: (row.campaign_name as string | null) ?? null,
    source_url: (row.source_url as string | null) ?? null,
    status: String(row.status),
    total_rows: row.total_rows == null ? null : Number(row.total_rows),
    staged_count: Number(row.staged_count || 0),
    skipped_count: Number(row.skipped_count || 0),
    chunk_count: Number(row.chunk_count || 0),
    auto_import: Boolean(row.auto_import),
    import_run_id: (row.import_run_id as string | null) ?? null,
    error_message: (row.error_message as string | null) ?? null,
    started_at: (row.started_at as string | null) ?? null,
    completed_at: (row.completed_at as string | null) ?? null,
    created_at: (row.created_at as string | null) ?? null,
  };
}

export async function getLeadStageStatus(
  runId: string
): Promise<LeadStageRunSummary> {
  const { data, error } = await db.select<Record<string, unknown>[]>(
    "lead_stage_runs",
    [
      "select=id,campaign_id,campaign_name,source_url,status,total_rows,staged_count,skipped_count,chunk_count,auto_import,import_run_id,error_message,started_at,completed_at,created_at",
      `id=eq.${runId}`,
      "limit=1",
    ].join("&")
  );
  if (error || !data?.[0]) {
    throw new Error(`Stage run not found: ${runId}`);
  }
  return summarize(data[0]);
}

export async function listLeadStageRuns(
  limit = 20
): Promise<LeadStageRunSummary[]> {
  const safeLimit = Math.min(Math.max(limit, 1), 100);
  const { data, error } = await db.select<Record<string, unknown>[]>(
    "lead_stage_runs",
    [
      "select=id,campaign_id,campaign_name,source_url,status,total_rows,staged_count,skipped_count,chunk_count,auto_import,import_run_id,error_message,started_at,completed_at,created_at",
      "order=created_at.desc",
      `limit=${safeLimit}`,
    ].join("&")
  );
  if (error) {
    throw new Error(`Failed to list stage runs: ${error.message}`);
  }
  return (data || []).map((row) => summarize(row));
}
