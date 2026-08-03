const BASE_URL = "https://server.smartlead.ai/api/v1";
const LEAD_CHUNK_SIZE = 400;
const CHUNK_DELAY_MS = 500;
const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 2000;

export type SequenceStep = {
  subject: string;
  body: string;
  delay: number;
};

export type Lead = {
  email: string;
  first_name?: string;
  last_name?: string;
  company_name?: string;
  phone_number?: string;
  website?: string;
  location?: string;
  linkedin_profile?: string;
  company_url?: string;
  custom_fields?: Record<string, string>;
  [key: string]: unknown;
};

export type CampaignSchedule = {
  timezone: string;
  days_of_the_week: number[];
  start_hour: string;
  end_hour: string;
  min_time_btw_emails: number;
  max_leads_per_day: number;
};

export type CampaignStatus = "ACTIVE" | "PAUSED" | "STOPPED";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveApiKey(): string {
  const key =
    process.env.SMARTLEAD_API_KEY ||
    process.env["bd7ac1f7-d7ad-4046-a033-fd0ce46e2aa9_l1vmzyk"];
  if (!key) {
    throw new Error(
      "SMARTLEAD_API_KEY is not set. Configure it as a Railway service variable."
    );
  }
  return key;
}

async function smartleadFetch(
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  const apiKey = resolveApiKey();
  const url = `${BASE_URL}${path}${path.includes("?") ? "&" : "?"}api_key=${encodeURIComponent(apiKey)}`;

  let attempt = 0;
  let backoff = INITIAL_BACKOFF_MS;

  while (true) {
    const response = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (response.status === 429) {
      attempt += 1;
      if (attempt > MAX_RETRIES) {
        const text = await response.text();
        throw new Error(
          `Smartlead rate limit exceeded after ${MAX_RETRIES} retries: ${text}`
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
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // keep raw text
    }

    if (!response.ok) {
      throw new Error(
        `Smartlead API ${method} ${path} failed (${response.status}): ${
          typeof data === "string" ? data : JSON.stringify(data)
        }`
      );
    }

    return data;
  }
}

export async function createCampaign(name: string): Promise<unknown> {
  return smartleadFetch("POST", "/campaigns/create", { name });
}

export async function uploadSequence(
  campaignId: string | number,
  steps: SequenceStep[]
): Promise<unknown> {
  const sequences = steps.map((step, index) => ({
    id: null,
    seq_number: index + 1,
    subject: step.subject,
    email_body: step.body,
    seq_delay_details: {
      delay_in_days: step.delay,
    },
  }));

  return smartleadFetch("POST", `/campaigns/${campaignId}/sequences`, {
    sequences,
  });
}

export async function linkMailboxes(
  campaignId: string | number,
  emailAccountIds: Array<string | number>
): Promise<unknown> {
  return smartleadFetch("POST", `/campaigns/${campaignId}/email-accounts`, {
    email_account_ids: emailAccountIds.map((id) => Number(id)),
  });
}

export type ImportLeadsResult = {
  total_leads: number;
  total_chunks: number;
  successful_chunks: number;
  failed_chunks: Array<{
    chunk_index: number;
    lead_offset: number;
    lead_count: number;
    error: string;
  }>;
  chunk_responses: unknown[];
};

export async function importLeads(
  campaignId: string | number,
  leads: Lead[]
): Promise<ImportLeadsResult> {
  const chunks: Lead[][] = [];
  for (let i = 0; i < leads.length; i += LEAD_CHUNK_SIZE) {
    chunks.push(leads.slice(i, i + LEAD_CHUNK_SIZE));
  }

  const result: ImportLeadsResult = {
    total_leads: leads.length,
    total_chunks: chunks.length,
    successful_chunks: 0,
    failed_chunks: [],
    chunk_responses: [],
  };

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const leadOffset = index * LEAD_CHUNK_SIZE;

    try {
      const response = await smartleadFetch(
        "POST",
        `/campaigns/${campaignId}/leads`,
        { lead_list: chunk }
      );
      result.successful_chunks += 1;
      result.chunk_responses.push({
        chunk_index: index,
        lead_offset: leadOffset,
        lead_count: chunk.length,
        response,
      });
    } catch (error) {
      result.failed_chunks.push({
        chunk_index: index,
        lead_offset: leadOffset,
        lead_count: chunk.length,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (index < chunks.length - 1) {
      await sleep(CHUNK_DELAY_MS);
    }
  }

  return result;
}

export async function setSchedule(
  campaignId: string | number,
  schedule: CampaignSchedule
): Promise<unknown> {
  return smartleadFetch(
    "POST",
    `/campaigns/${campaignId}/schedule`,
    schedule
  );
}

export async function updateCampaignStatus(
  campaignId: string | number,
  status: CampaignStatus
): Promise<unknown> {
  // Smartlead's PATCH status endpoint accepts START (not ACTIVE) to activate.
  const apiStatus = status === "ACTIVE" ? "START" : status;
  return smartleadFetch("PATCH", `/campaigns/${campaignId}/status`, {
    status: apiStatus,
  });
}

export async function getCampaignAnalytics(
  campaignId: string | number
): Promise<unknown> {
  return smartleadFetch("GET", `/campaigns/${campaignId}/analytics`);
}
