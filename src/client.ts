const BASE_URL = "https://server.smartlead.ai/api/v1";
export const LEAD_CHUNK_SIZE = 400;
const CHUNK_DELAY_MS = 500;
const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 2000;

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resolveApiKey(): string {
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

function fillPath(
  path: string,
  pathParams?: Record<string, string | number>
): string {
  let filled = path.startsWith("/") ? path : `/${path}`;
  if (pathParams) {
    for (const [key, value] of Object.entries(pathParams)) {
      filled = filled.replaceAll(`{${key}}`, encodeURIComponent(String(value)));
    }
  }
  if (/\{[^}]+\}/.test(filled)) {
    throw new Error(
      `Missing path params for "${path}". Remaining placeholders: ${filled}`
    );
  }
  return filled;
}

export async function smartleadRequest(options: {
  method: HttpMethod;
  path: string;
  pathParams?: Record<string, string | number>;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
}): Promise<unknown> {
  const apiKey = resolveApiKey();
  const filledPath = fillPath(options.path, options.pathParams);

  const query = new URLSearchParams();
  query.set("api_key", apiKey);
  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value === undefined || value === null) continue;
      query.set(key, String(value));
    }
  }

  const url = `${BASE_URL}${filledPath}?${query.toString()}`;
  let attempt = 0;
  let backoff = INITIAL_BACKOFF_MS;

  while (true) {
    const response = await fetch(url, {
      method: options.method,
      headers:
        options.body !== undefined
          ? { "Content-Type": "application/json" }
          : undefined,
      body:
        options.body !== undefined ? JSON.stringify(options.body) : undefined,
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

    const contentType = response.headers.get("content-type") || "";
    const text = await response.text();
    let data: unknown = text;
    if (contentType.includes("application/json") || text.startsWith("{") || text.startsWith("[")) {
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        // keep raw text
      }
    }

    if (!response.ok) {
      throw new Error(
        `Smartlead API ${options.method} ${filledPath} failed (${response.status}): ${
          typeof data === "string" ? data : JSON.stringify(data)
        }`
      );
    }

    return data;
  }
}

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

export async function importLeadsChunked(
  campaignId: string | number,
  leads: Lead[],
  settings?: Record<string, unknown>
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
      const body: Record<string, unknown> = { lead_list: chunk };
      if (settings) body.settings = settings;
      const response = await smartleadRequest({
        method: "POST",
        path: `/campaigns/${campaignId}/leads`,
        body,
      });
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
