import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listCategories, listEndpoints, catalog } from "./catalog.js";
import {
  importLeadsChunked,
  smartleadRequest,
  type HttpMethod,
  type Lead,
} from "./client.js";
import { buildSequencePayload } from "./sequences.js";

function textResult(data: unknown, isError = false) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
    isError,
  };
}

async function runTool(fn: () => Promise<unknown>) {
  try {
    return textResult(await fn());
  } catch (error) {
    return textResult(
      error instanceof Error ? error.message : String(error),
      true
    );
  }
}

const idSchema = z.union([z.string(), z.number()]);

const leadSchema = z
  .object({
    email: z.string().email(),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    company_name: z.string().optional(),
    phone_number: z.string().optional(),
    website: z.string().optional(),
    location: z.string().optional(),
    linkedin_profile: z.string().optional(),
    company_url: z.string().optional(),
    custom_fields: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

export function registerTools(server: McpServer): void {
  // ── Discovery / escape hatch ───────────────────────────────────────────
  server.registerTool(
    "list_smartlead_endpoints",
    {
      description:
        "Browse the Smartlead API endpoint catalog covered by this MCP server (campaigns, leads, email accounts, analytics, webhooks, inbox, clients, lead lists, smart delivery, smart prospect, smart senders). Use before smartlead_request when you need the exact path/method.",
      inputSchema: {
        category: z
          .string()
          .optional()
          .describe(
            "Filter by category: campaigns, leads, email_accounts, analytics, webhooks, clients, lead_lists, crm, inbox, utilities, smart_prospect, smart_delivery, smart_senders"
          ),
        search: z
          .string()
          .optional()
          .describe("Free-text search across name/path/description"),
        include_categories: z
          .boolean()
          .optional()
          .describe("If true, also return category counts"),
      },
    },
    async ({ category, search, include_categories }) =>
      runTool(async () => {
        const endpoints = listEndpoints({ category, search });
        return {
          base_url: catalog.base_url,
          source: catalog.source,
          total_in_catalog: catalog.count,
          matched: endpoints.length,
          categories: include_categories ? listCategories() : undefined,
          endpoints,
        };
      })
  );

  server.registerTool(
    "smartlead_request",
    {
      description:
        "Call any Smartlead API v1 endpoint. Prefer named convenience tools when available; use this for full API coverage (analytics, inbox, smart delivery, smart prospect, smart senders, clients, webhooks, etc.). Path may include {placeholders} filled via path_params. api_key is injected automatically. Handles 429 with exponential backoff.",
      inputSchema: {
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
        path: z
          .string()
          .describe(
            'API path under /api/v1, e.g. "/campaigns/{campaign_id}/analytics" or "/spam-test/report"'
          ),
        path_params: z
          .record(z.string(), z.union([z.string(), z.number()]))
          .optional()
          .describe('Placeholder values, e.g. {"campaign_id": 123}'),
        query: z
          .record(
            z.string(),
            z.union([z.string(), z.number(), z.boolean()])
          )
          .optional()
          .describe("Extra query params (api_key is added automatically)"),
        body: z
          .unknown()
          .optional()
          .describe("JSON request body for POST/PUT/PATCH/DELETE"),
      },
    },
    async ({ method, path, path_params, query, body }) =>
      runTool(() =>
        smartleadRequest({
          method: method as HttpMethod,
          path,
          pathParams: path_params,
          query,
          body,
        })
      )
  );

  // ── Original convenience campaign lifecycle tools ──────────────────────
  server.registerTool(
    "create_campaign",
    {
      description: "Create a new Smartlead campaign (DRAFTED).",
      inputSchema: {
        name: z.string(),
        client_id: z.number().nullable().optional(),
      },
    },
    async ({ name, client_id }) =>
      runTool(() =>
        smartleadRequest({
          method: "POST",
          path: "/campaigns/create",
          body: {
            name,
            ...(client_id !== undefined ? { client_id } : {}),
          },
        })
      )
  );

  server.registerTool(
    "list_campaigns",
    {
      description: "List all Smartlead campaigns.",
      inputSchema: {
        include_tags: z.boolean().optional(),
        client_id: z.number().optional(),
      },
    },
    async ({ include_tags, client_id }) =>
      runTool(() =>
        smartleadRequest({
          method: "GET",
          path: "/campaigns/",
          query: { include_tags, client_id },
        })
      )
  );

  server.registerTool(
    "get_campaign",
    {
      description: "Get a Smartlead campaign by ID.",
      inputSchema: { campaign_id: idSchema },
    },
    async ({ campaign_id }) =>
      runTool(() =>
        smartleadRequest({
          method: "GET",
          path: "/campaigns/{campaign_id}",
          pathParams: { campaign_id },
        })
      )
  );

  server.registerTool(
    "delete_campaign",
    {
      description: "Permanently delete a Smartlead campaign.",
      inputSchema: { campaign_id: idSchema },
    },
    async ({ campaign_id }) =>
      runTool(() =>
        smartleadRequest({
          method: "DELETE",
          path: "/campaigns/{campaign_id}",
          pathParams: { campaign_id },
        })
      )
  );

  server.registerTool(
    "upload_sequence",
    {
      description:
        "Upload/replace campaign email sequences. Each step can be a single subject/body, or multiple A/B variants via `variants` (posted as Smartlead `seq_variants` with labels A, B, C...; returned by get_sequences as `sequence_variants`). Supports spintax and {{merge}} tags. Campaign must not be ACTIVE.",
      inputSchema: {
        campaign_id: idSchema,
        steps: z
          .array(
            z
              .object({
                delay: z
                  .number()
                  .int()
                  .min(0)
                  .describe("Days to wait before this step sends"),
                subject: z
                  .string()
                  .optional()
                  .describe(
                    "Subject for a single-variant step (omit or leave empty when using variants)"
                  ),
                body: z
                  .string()
                  .optional()
                  .describe(
                    "Body for a single-variant step (omit when using variants)"
                  ),
                variants: z
                  .array(
                    z.object({
                      subject: z.string().describe("Variant subject"),
                      body: z.string().describe("Variant body HTML/text"),
                      variant_label: z
                        .string()
                        .optional()
                        .describe(
                          'Optional label override (defaults to A, B, C...)'
                        ),
                    })
                  )
                  .min(2)
                  .optional()
                  .describe(
                    "When present, posts native Smartlead seq_variants for this step"
                  ),
              })
              .superRefine((step, ctx) => {
                const hasVariants = Boolean(step.variants?.length);
                if (!hasVariants && step.body === undefined) {
                  ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message:
                      "Provide either `body` (single-variant step) or `variants` (multi-variant step)",
                    path: ["body"],
                  });
                }
              })
          )
          .min(1),
      },
    },
    async ({ campaign_id, steps }) =>
      runTool(() =>
        smartleadRequest({
          method: "POST",
          path: "/campaigns/{campaign_id}/sequences",
          pathParams: { campaign_id },
          body: {
            sequences: steps.map((step, index) =>
              buildSequencePayload(step, index + 1)
            ),
          },
        })
      )
  );

  server.registerTool(
    "get_sequences",
    {
      description: "Fetch sequences for a campaign.",
      inputSchema: { campaign_id: idSchema },
    },
    async ({ campaign_id }) =>
      runTool(() =>
        smartleadRequest({
          method: "GET",
          path: "/campaigns/{campaign_id}/sequences",
          pathParams: { campaign_id },
        })
      )
  );

  server.registerTool(
    "link_mailboxes",
    {
      description: "Link sender email account IDs to a campaign.",
      inputSchema: {
        campaign_id: idSchema,
        email_account_ids: z.array(idSchema).min(1),
      },
    },
    async ({ campaign_id, email_account_ids }) =>
      runTool(() =>
        smartleadRequest({
          method: "POST",
          path: "/campaigns/{campaign_id}/email-accounts",
          pathParams: { campaign_id },
          body: {
            email_account_ids: email_account_ids.map((id) => Number(id)),
          },
        })
      )
  );

  server.registerTool(
    "unlink_mailboxes",
    {
      description: "Remove sender email account IDs from a campaign.",
      inputSchema: {
        campaign_id: idSchema,
        email_account_ids: z.array(idSchema).min(1),
      },
    },
    async ({ campaign_id, email_account_ids }) =>
      runTool(() =>
        smartleadRequest({
          method: "DELETE",
          path: "/campaigns/{campaign_id}/email-accounts",
          pathParams: { campaign_id },
          body: {
            email_account_ids: email_account_ids.map((id) => Number(id)),
          },
        })
      )
  );

  server.registerTool(
    "list_campaign_mailboxes",
    {
      description: "List email accounts linked to a campaign.",
      inputSchema: { campaign_id: idSchema },
    },
    async ({ campaign_id }) =>
      runTool(() =>
        smartleadRequest({
          method: "GET",
          path: "/campaigns/{campaign_id}/email-accounts",
          pathParams: { campaign_id },
        })
      )
  );

  server.registerTool(
    "import_leads",
    {
      description:
        "Import leads into a campaign. Auto-chunks into batches of 400 (Smartlead hard limit), delays between chunks, returns import summary + failed chunks.",
      inputSchema: {
        campaign_id: idSchema,
        leads: z.array(leadSchema).min(1),
        settings: z
          .object({
            ignore_global_block_list: z.boolean().optional(),
            ignore_unsubscribe_list: z.boolean().optional(),
            ignore_community_bounce_list: z.boolean().optional(),
            ignore_duplicate_leads_in_other_campaign: z.boolean().optional(),
          })
          .optional(),
      },
    },
    async ({ campaign_id, leads, settings }) => {
      try {
        const result = await importLeadsChunked(
          campaign_id,
          leads as Lead[],
          settings
        );
        return textResult(result, result.failed_chunks.length > 0);
      } catch (error) {
        return textResult(
          error instanceof Error ? error.message : String(error),
          true
        );
      }
    }
  );

  server.registerTool(
    "list_campaign_leads",
    {
      description: "List leads in a campaign (paginated).",
      inputSchema: {
        campaign_id: idSchema,
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ campaign_id, offset, limit }) =>
      runTool(() =>
        smartleadRequest({
          method: "GET",
          path: "/campaigns/{campaign_id}/leads",
          pathParams: { campaign_id },
          query: { offset, limit },
        })
      )
  );

  server.registerTool(
    "set_schedule",
    {
      description:
        "Configure campaign sending schedule. Accepts max_leads_per_day or max_new_leads_per_day; Smartlead receives max_new_leads_per_day.",
      inputSchema: {
        campaign_id: idSchema,
        schedule: z
          .object({
            timezone: z.string(),
            days_of_the_week: z.array(z.number().int().min(0).max(6)).min(1),
            start_hour: z.string(),
            end_hour: z.string(),
            min_time_btw_emails: z.number().int().min(1),
            max_new_leads_per_day: z.number().int().min(1).optional(),
            max_leads_per_day: z
              .number()
              .int()
              .min(1)
              .optional()
              .describe(
                "Alias for max_new_leads_per_day (translated before calling Smartlead)"
              ),
          })
          .superRefine((schedule, ctx) => {
            if (
              schedule.max_new_leads_per_day === undefined &&
              schedule.max_leads_per_day === undefined
            ) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message:
                  "Provide max_new_leads_per_day (or alias max_leads_per_day)",
                path: ["max_new_leads_per_day"],
              });
            }
          }),
      },
    },
    async ({ campaign_id, schedule }) =>
      runTool(() => {
        const {
          max_leads_per_day,
          max_new_leads_per_day,
          ...rest
        } = schedule;
        return smartleadRequest({
          method: "POST",
          path: "/campaigns/{campaign_id}/schedule",
          pathParams: { campaign_id },
          body: {
            ...rest,
            max_new_leads_per_day:
              max_new_leads_per_day ?? max_leads_per_day,
          },
        });
      })
  );

  server.registerTool(
    "update_campaign_settings",
    {
      description:
        "Update campaign settings (tracking, stop conditions, plain text, AI ESP matching, etc.).",
      inputSchema: {
        campaign_id: idSchema,
        settings: z.record(z.string(), z.unknown()),
      },
    },
    async ({ campaign_id, settings }) =>
      runTool(() =>
        smartleadRequest({
          method: "POST",
          path: "/campaigns/{campaign_id}/settings",
          pathParams: { campaign_id },
          body: settings,
        })
      )
  );

  server.registerTool(
    "update_campaign_status",
    {
      description:
        "Update campaign status to ACTIVE, PAUSED, or STOPPED. ACTIVE is sent as START (Smartlead API).",
      inputSchema: {
        campaign_id: idSchema,
        status: z.enum(["ACTIVE", "PAUSED", "STOPPED", "START"]),
      },
    },
    async ({ campaign_id, status }) =>
      runTool(async () => {
        const apiStatus = status === "ACTIVE" ? "START" : status;
        // Official docs use POST; help center also documents PATCH — try POST first.
        try {
          return await smartleadRequest({
            method: "POST",
            path: "/campaigns/{campaign_id}/status",
            pathParams: { campaign_id },
            body: { status: apiStatus },
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          if (!message.includes("(405)") && !message.includes("(404)")) {
            throw error;
          }
          return smartleadRequest({
            method: "PATCH",
            path: "/campaigns/{campaign_id}/status",
            pathParams: { campaign_id },
            body: { status: apiStatus },
          });
        }
      })
  );

  server.registerTool(
    "get_campaign_analytics",
    {
      description: "Top-level analytics for a campaign.",
      inputSchema: { campaign_id: idSchema },
    },
    async ({ campaign_id }) =>
      runTool(() =>
        smartleadRequest({
          method: "GET",
          path: "/campaigns/{campaign_id}/analytics",
          pathParams: { campaign_id },
        })
      )
  );

  server.registerTool(
    "get_campaign_analytics_by_date",
    {
      description: "Campaign analytics for a date range (max 30 days).",
      inputSchema: {
        campaign_id: idSchema,
        start_date: z.string().describe("YYYY-MM-DD"),
        end_date: z.string().describe("YYYY-MM-DD"),
      },
    },
    async ({ campaign_id, start_date, end_date }) =>
      runTool(() =>
        smartleadRequest({
          method: "GET",
          path: "/campaigns/{campaign_id}/analytics-by-date",
          pathParams: { campaign_id },
          query: { start_date, end_date },
        })
      )
  );

  server.registerTool(
    "get_campaign_statistics",
    {
      description: "Detailed campaign statistics with optional filters.",
      inputSchema: {
        campaign_id: idSchema,
        email_sequence_number: z.number().optional(),
        email_status: z
          .enum(["opened", "clicked", "replied", "unsubscribed", "bounced"])
          .optional(),
        offset: z.number().optional(),
        limit: z.number().optional(),
      },
    },
    async ({
      campaign_id,
      email_sequence_number,
      email_status,
      offset,
      limit,
    }) =>
      runTool(() =>
        smartleadRequest({
          method: "GET",
          path: "/campaigns/{campaign_id}/statistics",
          pathParams: { campaign_id },
          query: { email_sequence_number, email_status, offset, limit },
        })
      )
  );

  server.registerTool(
    "get_analytics_overview",
    {
      description: "Global analytics overview across all campaigns.",
      inputSchema: {
        query: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional(),
      },
    },
    async ({ query }) =>
      runTool(() =>
        smartleadRequest({
          method: "GET",
          path: "/analytics/overall-stats-v2",
          query,
        })
      )
  );

  // ── Email accounts ─────────────────────────────────────────────────────
  server.registerTool(
    "list_email_accounts",
    {
      description: "List Smartlead email accounts.",
      inputSchema: {
        offset: z.number().optional(),
        limit: z.number().optional(),
      },
    },
    async ({ offset, limit }) =>
      runTool(() =>
        smartleadRequest({
          method: "GET",
          path: "/email-accounts/",
          query: { offset, limit },
        })
      )
  );

  server.registerTool(
    "get_email_account",
    {
      description: "Get an email account by ID.",
      inputSchema: { email_account_id: idSchema },
    },
    async ({ email_account_id }) =>
      runTool(() =>
        smartleadRequest({
          method: "GET",
          path: "/email-accounts/{email_account_id}/",
          pathParams: { email_account_id },
        })
      )
  );

  server.registerTool(
    "create_email_account",
    {
      description: "Create an SMTP email account.",
      inputSchema: {
        account: z.record(z.string(), z.unknown()),
      },
    },
    async ({ account }) =>
      runTool(() =>
        smartleadRequest({
          method: "POST",
          path: "/email-accounts/save",
          body: account,
        })
      )
  );

  server.registerTool(
    "update_email_account",
    {
      description: "Update an email account.",
      inputSchema: {
        email_account_id: idSchema,
        account: z.record(z.string(), z.unknown()),
      },
    },
    async ({ email_account_id, account }) =>
      runTool(() =>
        smartleadRequest({
          method: "POST",
          path: "/email-accounts/{email_account_id}",
          pathParams: { email_account_id },
          body: account,
        })
      )
  );

  server.registerTool(
    "configure_warmup",
    {
      description: "Configure warmup for an email account.",
      inputSchema: {
        email_account_id: idSchema,
        warmup: z.record(z.string(), z.unknown()),
      },
    },
    async ({ email_account_id, warmup }) =>
      runTool(() =>
        smartleadRequest({
          method: "POST",
          path: "/email-accounts/{email_account_id}/warmup",
          pathParams: { email_account_id },
          body: warmup,
        })
      )
  );

  server.registerTool(
    "get_warmup_stats",
    {
      description: "Get warmup stats for an email account.",
      inputSchema: { email_account_id: idSchema },
    },
    async ({ email_account_id }) =>
      runTool(() =>
        smartleadRequest({
          method: "GET",
          path: "/email-accounts/{email_account_id}/warmup-stats",
          pathParams: { email_account_id },
        })
      )
  );

  // ── Lead helpers ───────────────────────────────────────────────────────
  server.registerTool(
    "get_lead_by_email",
    {
      description: "Fetch a lead by email address.",
      inputSchema: { email: z.string().email() },
    },
    async ({ email }) =>
      runTool(() =>
        smartleadRequest({
          method: "GET",
          path: "/leads/",
          query: { email },
        })
      )
  );

  server.registerTool(
    "pause_lead",
    {
      description: "Pause a lead in a campaign.",
      inputSchema: { campaign_id: idSchema, lead_id: idSchema },
    },
    async ({ campaign_id, lead_id }) =>
      runTool(() =>
        smartleadRequest({
          method: "POST",
          path: "/campaigns/{campaign_id}/leads/{lead_id}/pause",
          pathParams: { campaign_id, lead_id },
        })
      )
  );

  server.registerTool(
    "resume_lead",
    {
      description: "Resume a lead in a campaign.",
      inputSchema: { campaign_id: idSchema, lead_id: idSchema },
    },
    async ({ campaign_id, lead_id }) =>
      runTool(() =>
        smartleadRequest({
          method: "POST",
          path: "/campaigns/{campaign_id}/leads/{lead_id}/resume",
          pathParams: { campaign_id, lead_id },
        })
      )
  );

  server.registerTool(
    "unsubscribe_lead",
    {
      description:
        "Unsubscribe a lead from a campaign, or globally if campaign_id is omitted.",
      inputSchema: {
        lead_id: idSchema,
        campaign_id: idSchema.optional(),
      },
    },
    async ({ lead_id, campaign_id }) =>
      runTool(() =>
        campaign_id !== undefined
          ? smartleadRequest({
              method: "POST",
              path: "/campaigns/{campaign_id}/leads/{lead_id}/unsubscribe",
              pathParams: { campaign_id, lead_id },
            })
          : smartleadRequest({
              method: "POST",
              path: "/leads/{lead_id}/unsubscribe",
              pathParams: { lead_id },
            })
      )
  );

  server.registerTool(
    "reply_to_lead",
    {
      description: "Reply to a lead email thread from the master inbox.",
      inputSchema: {
        campaign_id: idSchema,
        lead_id: idSchema,
        email_body: z.string(),
        reply_message_id: z.string(),
        reply_email_time: z.string(),
      },
    },
    async ({
      campaign_id,
      lead_id,
      email_body,
      reply_message_id,
      reply_email_time,
    }) =>
      runTool(() =>
        smartleadRequest({
          method: "POST",
          path: "/campaigns/{campaign_id}/reply-email-thread",
          pathParams: { campaign_id },
          body: {
            lead_id: Number(lead_id),
            email_body,
            reply_message_id,
            reply_email_time,
          },
        })
      )
  );

  server.registerTool(
    "export_campaign_leads",
    {
      description: "Export campaign leads as CSV/data.",
      inputSchema: { campaign_id: idSchema },
    },
    async ({ campaign_id }) =>
      runTool(() =>
        smartleadRequest({
          method: "GET",
          path: "/campaigns/{campaign_id}/leads-export",
          pathParams: { campaign_id },
        })
      )
  );

  server.registerTool(
    "add_to_block_list",
    {
      description: "Add an email or domain to the global block list.",
      inputSchema: {
        email: z.string().email().optional(),
        domain: z.string().optional(),
      },
    },
    async ({ email, domain }) =>
      runTool(async () => {
        if (!email && !domain) {
          throw new Error("Provide either email or domain");
        }
        return smartleadRequest({
          method: "POST",
          path: "/leads/add-domain-block-list",
          body: email ? { email } : { domain },
        });
      })
  );

  // ── Webhooks / clients / lists / inbox shortcuts ───────────────────────
  server.registerTool(
    "create_webhook",
    {
      description: "Create a Smartlead webhook.",
      inputSchema: { webhook: z.record(z.string(), z.unknown()) },
    },
    async ({ webhook }) =>
      runTool(() =>
        smartleadRequest({
          method: "POST",
          path: "/webhook/create",
          body: webhook,
        })
      )
  );

  server.registerTool(
    "list_clients",
    {
      description: "List agency clients.",
      inputSchema: {},
    },
    async () =>
      runTool(() =>
        smartleadRequest({
          method: "GET",
          path: "/client/",
        })
      )
  );

  server.registerTool(
    "list_lead_lists",
    {
      description: "List lead lists.",
      inputSchema: {},
    },
    async () =>
      runTool(() =>
        smartleadRequest({
          method: "GET",
          path: "/lead-list/",
        })
      )
  );

  server.registerTool(
    "list_inbox_replies",
    {
      description:
        "Fetch master-inbox replies. Pass filters in body per Smartlead inbox API.",
      inputSchema: {
        filters: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async ({ filters }) =>
      runTool(() =>
        smartleadRequest({
          method: "POST",
          path: "/master-inbox/inbox-replies",
          body: filters ?? {},
        })
      )
  );

  server.registerTool(
    "duplicate_campaign",
    {
      description: "Duplicate an existing campaign.",
      inputSchema: {
        campaign_id: idSchema,
        options: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async ({ campaign_id, options }) =>
      runTool(() =>
        smartleadRequest({
          method: "POST",
          path: "/campaigns/{campaign_id}/duplicate",
          pathParams: { campaign_id },
          body: options ?? {},
        })
      )
  );
}
