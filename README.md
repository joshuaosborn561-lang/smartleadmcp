# Smartlead MCP Server

Persistent [Model Context Protocol](https://modelcontextprotocol.io) server that wraps the full [Smartlead API](https://server.smartlead.ai/api/v1) for use as a Claude custom connector.

Base URL: `https://server.smartlead.ai/api/v1`  
Auth: `api_key` query param (injected from `SMARTLEAD_API_KEY`)

## Claude connector URL

```
https://workspace-production-9629.up.railway.app/mcp
```

Add that under Claude **Settings → Connectors**.

## Coverage

This server ships:

1. **Named convenience tools** for the common campaign lifecycle and day-to-day ops
2. **`list_smartlead_endpoints`** — browse a curated catalog of ~195 documented endpoints across all Smartlead API areas
3. **`smartlead_request`** — call *any* Smartlead v1 path/method (full API escape hatch), with automatic `api_key` injection and 429 exponential backoff

### Catalog categories

| Category | Examples |
|----------|----------|
| `campaigns` | create/list/get/delete, status, schedule, settings, sequences, duplicate, subsequences |
| `leads` | import (auto-chunk 400), pause/resume/unsubscribe, message history, reply, export, block list |
| `email_accounts` | SMTP/OAuth accounts, warmup, suspend, tags |
| `analytics` | campaign analytics, date ranges, global overview, mailbox/provider/client stats |
| `webhooks` | create/update/delete + campaign webhook management |
| `clients` | agency clients + client API keys |
| `lead_lists` | lists, import, tags, push between lists/campaigns |
| `crm` | lead tags, notes, tasks |
| `inbox` | master inbox replies, categories, reminders, tasks, block domains |
| `smart_prospect` | contact search, filters, saved/fetched searches |
| `smart_delivery` | spam/placement tests, folders, DKIM/SPF/IP/provider reports |
| `smart_senders` | vendors, domains, mailbox generation, orders |
| `utilities` | one-off send email |

Also available at `GET /catalog` on the deployed service.

### Key convenience tools

- `create_campaign`, `list_campaigns`, `get_campaign`, `delete_campaign`, `duplicate_campaign`
- `upload_sequence` (supports per-step `variants` → Smartlead `seq_variants`), `get_sequences`
- `link_mailboxes`, `unlink_mailboxes`, `list_campaign_mailboxes`
- `import_leads` (**auto-chunks at 400**), `list_campaign_leads`, `export_campaign_leads`
- `set_schedule`, `update_campaign_settings`, `update_campaign_status`
- `get_campaign_analytics`, `get_campaign_analytics_by_date`, `get_campaign_statistics`, `get_analytics_overview`
- `list_email_accounts`, `get_email_account`, `create_email_account`, `update_email_account`, `configure_warmup`, `get_warmup_stats`
- `get_lead_by_email`, `pause_lead`, `resume_lead`, `unsubscribe_lead`, `reply_to_lead`, `add_to_block_list`
- `create_webhook`, `list_clients`, `list_lead_lists`, `list_inbox_replies`
- `start_lead_import`, `get_lead_import_status`, `list_lead_import_runs` (Supabase `leads_staging` → Smartlead background import)
- `list_smartlead_endpoints`, `smartlead_request`

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `SMARTLEAD_API_KEY` | Yes | Smartlead API key |
| `SUPABASE_URL` | Yes (for staged imports) | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes (for staged imports) | Service-role key for `leads_staging` / import run tables |
| `PORT` | No | HTTP port (Railway injects this) |

## Local development

```bash
npm install
npm run build
export SMARTLEAD_API_KEY=your_key
npm start
```

MCP endpoint: `http://localhost:3000/mcp` (Streamable HTTP).

## Deploy on Railway

Persistent web service (not a cron):

```bash
railway up -y
railway variable set SMARTLEAD_API_KEY=your_key
railway domain
```
