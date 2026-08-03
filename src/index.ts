import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import {
  createCampaign,
  getCampaignAnalytics,
  importLeads,
  linkMailboxes,
  setSchedule,
  updateCampaignStatus,
  uploadSequence,
  type Lead,
} from "./smartlead.js";

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

function createServer(): McpServer {
  const server = new McpServer({
    name: "smartlead-mcp",
    version: "1.0.0",
  });

  server.registerTool(
    "create_campaign",
    {
      description:
        "Create a new Smartlead email campaign. New campaigns start in DRAFTED status.",
      inputSchema: {
        name: z.string().describe("Campaign name"),
      },
    },
    async ({ name }) => {
      try {
        const result = await createCampaign(name);
        return textResult(result);
      } catch (error) {
        return textResult(
          error instanceof Error ? error.message : String(error),
          true
        );
      }
    }
  );

  server.registerTool(
    "upload_sequence",
    {
      description:
        "Upload or replace the email sequence for a Smartlead campaign. Each step supports spintax in subject/body and a delay in days before sending.",
      inputSchema: {
        campaign_id: z
          .union([z.string(), z.number()])
          .describe("Smartlead campaign ID"),
        steps: z
          .array(
            z.object({
              subject: z
                .string()
                .describe("Email subject (supports spintax and {{merge}} tags)"),
              body: z
                .string()
                .describe(
                  "Email body HTML/text (supports spintax and {{merge}} tags)"
                ),
              delay: z
                .number()
                .int()
                .min(0)
                .describe("Days to wait before this step sends"),
            })
          )
          .min(1)
          .describe("Ordered sequence steps"),
      },
    },
    async ({ campaign_id, steps }) => {
      try {
        const result = await uploadSequence(campaign_id, steps);
        return textResult(result);
      } catch (error) {
        return textResult(
          error instanceof Error ? error.message : String(error),
          true
        );
      }
    }
  );

  server.registerTool(
    "link_mailboxes",
    {
      description:
        "Associate sender email account IDs with a Smartlead campaign for rotation/sending.",
      inputSchema: {
        campaign_id: z
          .union([z.string(), z.number()])
          .describe("Smartlead campaign ID"),
        email_account_ids: z
          .array(z.union([z.string(), z.number()]))
          .min(1)
          .describe("Smartlead email account IDs to link"),
      },
    },
    async ({ campaign_id, email_account_ids }) => {
      try {
        const result = await linkMailboxes(campaign_id, email_account_ids);
        return textResult(result);
      } catch (error) {
        return textResult(
          error instanceof Error ? error.message : String(error),
          true
        );
      }
    }
  );

  server.registerTool(
    "import_leads",
    {
      description:
        "Import leads into a Smartlead campaign. Automatically chunks into batches of 400 (Smartlead hard limit), with a short delay between chunks. Returns a summary of imported leads and any failed chunks.",
      inputSchema: {
        campaign_id: z
          .union([z.string(), z.number()])
          .describe("Smartlead campaign ID"),
        leads: z
          .array(
            z
              .object({
                email: z.string().email().describe("Lead email address"),
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
              .passthrough()
          )
          .min(1)
          .describe("Leads to import"),
      },
    },
    async ({ campaign_id, leads }) => {
      try {
        const result = await importLeads(campaign_id, leads as Lead[]);
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
    "set_schedule",
    {
      description:
        "Configure the sending schedule for a Smartlead campaign (timezone, days, hours, pacing).",
      inputSchema: {
        campaign_id: z
          .union([z.string(), z.number()])
          .describe("Smartlead campaign ID"),
        schedule: z
          .object({
            timezone: z
              .string()
              .describe('IANA timezone, e.g. "America/New_York"'),
            days_of_the_week: z
              .array(z.number().int().min(0).max(6))
              .min(1)
              .describe("0=Sunday … 6=Saturday"),
            start_hour: z.string().describe('Start hour "HH:MM" (24h)'),
            end_hour: z.string().describe('End hour "HH:MM" (24h)'),
            min_time_btw_emails: z
              .number()
              .int()
              .min(1)
              .describe("Minutes between consecutive emails"),
            max_leads_per_day: z
              .number()
              .int()
              .min(1)
              .describe("Max new leads to contact per day"),
          })
          .describe("Campaign schedule settings"),
      },
    },
    async ({ campaign_id, schedule }) => {
      try {
        const result = await setSchedule(campaign_id, schedule);
        return textResult(result);
      } catch (error) {
        return textResult(
          error instanceof Error ? error.message : String(error),
          true
        );
      }
    }
  );

  server.registerTool(
    "update_campaign_status",
    {
      description:
        "Update a Smartlead campaign status to ACTIVE, PAUSED, or STOPPED.",
      inputSchema: {
        campaign_id: z
          .union([z.string(), z.number()])
          .describe("Smartlead campaign ID"),
        status: z
          .enum(["ACTIVE", "PAUSED", "STOPPED"])
          .describe("Desired campaign status"),
      },
    },
    async ({ campaign_id, status }) => {
      try {
        const result = await updateCampaignStatus(campaign_id, status);
        return textResult(result);
      } catch (error) {
        return textResult(
          error instanceof Error ? error.message : String(error),
          true
        );
      }
    }
  );

  server.registerTool(
    "get_campaign_analytics",
    {
      description:
        "Fetch top-level analytics for a Smartlead campaign (sends, opens, clicks, replies, bounces, etc.).",
      inputSchema: {
        campaign_id: z
          .union([z.string(), z.number()])
          .describe("Smartlead campaign ID"),
      },
    },
    async ({ campaign_id }) => {
      try {
        const result = await getCampaignAnalytics(campaign_id);
        return textResult(result);
      } catch (error) {
        return textResult(
          error instanceof Error ? error.message : String(error),
          true
        );
      }
    }
  );

  return server;
}

const app = express();
app.use(express.json({ limit: "10mb" }));

app.get("/", (_req, res) => {
  res.json({
    name: "smartlead-mcp",
    version: "1.0.0",
    mcp: "/mcp",
    status: "ok",
  });
});

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.post("/mcp", async (req, res) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP request error:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.get("/mcp", (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed. Use POST for Streamable HTTP MCP.",
    },
    id: null,
  });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, "0.0.0.0", () => {
  console.log(`Smartlead MCP server listening on 0.0.0.0:${port}`);
  console.log(`MCP endpoint: http://0.0.0.0:${port}/mcp`);
});
