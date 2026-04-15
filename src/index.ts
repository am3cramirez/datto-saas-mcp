#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = "https://api.datto.com/v1";

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function getAuthHeader(): string {
  const publicKey = process.env.DATTO_PUBLIC_KEY;
  const secretKey = process.env.DATTO_SECRET_KEY;
  if (!publicKey || !secretKey) {
    throw new Error(
      "DATTO_PUBLIC_KEY and DATTO_SECRET_KEY environment variables must be set."
    );
  }
  const credentials = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
  return `Basic ${credentials}`;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function dattoFetch(
  path: string,
  params?: Record<string, string>,
  options?: { method?: string; body?: unknown }
): Promise<unknown> {
  const url = new URL(`${BASE_URL}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url.toString(), {
    method: options?.method ?? "GET",
    headers: {
      Authorization: getAuthHeader(),
      "Content-Type": "application/json",
    },
    body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  if (response.status === 429) {
    await new Promise((r) => setTimeout(r, 60_000));
    return dattoFetch(path, params, options);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Datto API error ${response.status} ${response.statusText}: ${text}`);
  }

  return response.json();
}

type PagedResponse = {
  items?: unknown[];
  data?: unknown[];
  pagination?: { page: number; perPage: number; totalPages: number; count: number };
};

/**
 * Fetches all pages using _page / _perPage pagination style.
 */
async function fetchAllPages(
  path: string,
  params?: Record<string, string>
): Promise<unknown[]> {
  const results: unknown[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const pageParams = { ...params, _page: String(page), _perPage: String(perPage) };
    const data = (await dattoFetch(path, pageParams)) as PagedResponse | unknown[];

    if (Array.isArray(data)) {
      results.push(...data);
      break; // no pagination envelope — all results returned at once
    }

    const items = data.items ?? data.data ?? [];
    results.push(...(items as unknown[]));

    const pagination = data.pagination;
    if (!pagination || page >= pagination.totalPages) break;
    page++;
  }

  return results;
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "datto-saas-mcp",
  version: "0.2.0",
});

// ===========================================================================
// SaaS Protection
// ===========================================================================

// ---- list_domains ----------------------------------------------------------

server.tool(
  "list_domains",
  `GET /v1/saas/domains
List all SaaS-protected customer domains managed by the partner.
Results are filtered if your API key is restricted to an organization.

Each record includes:
  - saasCustomerId        — used in all other SaaS calls
  - externalSubscriptionId — used in bulk_seat_change
  - domain, saasCustomerName, organizationId, organizationName
  - productType (Office365 | GoogleWorkspace)
  - seatsUsed, retentionType
  - backupStats: activeServicesCount, activeServicesWithRecentBackupCount, backupPercentage`,
  {},
  async () => {
    const domains = await fetchAllPages("/saas/domains");
    return {
      content: [{ type: "text" as const, text: JSON.stringify(domains, null, 2) }],
    };
  }
);

// ---- list_seats ------------------------------------------------------------

server.tool(
  "list_seats",
  `GET /v1/saas/{saasCustomerId}/seats
List licensed seats for a specific SaaS Protection customer.

Each record includes: mainId, name, seatType, seatState, billable, dateAdded, remoteId.
seatType values: User | Site | TeamSite | SharedMailbox | Team | SharedDrive`,
  {
    saasCustomerId: z
      .number()
      .int()
      .positive()
      .describe("SaaS Protection customer ID — obtain from list_domains"),
    seatType: z
      .array(
        z.enum(["User", "Site", "TeamSite", "SharedMailbox", "Team", "SharedDrive"])
      )
      .optional()
      .describe("Filter by seat type(s). Omit to return all types."),
  },
  async ({ saasCustomerId, seatType }) => {
    const params: Record<string, string> = {};
    if (seatType && seatType.length > 0) {
      params.seatType = seatType.join(",");
    }
    const seats = await fetchAllPages(`/saas/${saasCustomerId}/seats`, params);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(seats, null, 2) }],
    };
  }
);

// ---- get_applications ------------------------------------------------------

server.tool(
  "get_applications",
  `GET /v1/saas/{saasCustomerId}/applications
Get SaaS backup data for a specific customer. Primary reporting endpoint.

Response structure per customer:
  - customerId, customerName, usedBytes
  - suites[]: suiteType, appTypes[]: appType, backupHistory[]
      backupHistory fields: activeServiceCount, activeServiceWithBackupCount,
      activeServiceWithPerfectBackupCount, endTime, startTime, status,
      timeWindow, totalServiceCount
  - status values: Perfect | Good | Fair | Poor | Unknown`,
  {
    saasCustomerId: z
      .number()
      .int()
      .positive()
      .describe("SaaS Protection customer ID — obtain from list_domains"),
    daysUntil: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Days of backup history to include (default: API default)"),
  },
  async ({ saasCustomerId, daysUntil }) => {
    const params: Record<string, string> = {};
    if (daysUntil !== undefined) params.daysUntil = String(daysUntil);

    const data = await dattoFetch(`/saas/${saasCustomerId}/applications`, params);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  }
);

// ---- bulk_seat_change ------------------------------------------------------

server.tool(
  "bulk_seat_change",
  `PUT /v1/saas/{saasCustomerId}/{externalSubscriptionId}/bulkSeatChange
License, unlicense, or pause multiple seats in bulk (max 100 IDs per call).

seat_type values  : User | SharedMailbox | Site | TeamSite | Team | SharedDrive
action_type values: License | Unlicense | Pause
ids               : array of remoteId values from list_seats

Returns: { action, appType, customerId, id, status }`,
  {
    saasCustomerId: z
      .number()
      .int()
      .positive()
      .describe("SaaS Protection customer ID — obtain from list_domains"),
    externalSubscriptionId: z
      .string()
      .describe(
        "External subscription ID — obtain from list_domains (e.g. Classic:Office365:123456)"
      ),
    seat_type: z
      .enum(["User", "SharedMailbox", "Site", "TeamSite", "Team", "SharedDrive"])
      .describe("Type of seats being changed"),
    action_type: z
      .enum(["License", "Unlicense", "Pause"])
      .describe("Action to perform on the seats"),
    ids: z
      .array(z.string())
      .min(1)
      .max(100)
      .describe("Array of remoteId values (from list_seats) to act on (max 100)"),
  },
  async ({ saasCustomerId, externalSubscriptionId, seat_type, action_type, ids }) => {
    const data = await dattoFetch(
      `/saas/${saasCustomerId}/${encodeURIComponent(externalSubscriptionId)}/bulkSeatChange`,
      undefined,
      { method: "PUT", body: { seat_type, action_type, ids } }
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  }
);

// ---- get_all_applications_report -------------------------------------------

server.tool(
  "get_all_applications_report",
  `Convenience tool: fetches backup application data for ALL customer domains.
Internally calls list_domains then get_applications for each domain.

Returns an array of { saasCustomerId, domain, applications } objects.
Errors per domain are captured individually so one failure does not abort the rest.
Large fleets may take time — use list_domains to filter first if needed.`,
  {
    daysUntil: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Days of backup history per domain (default: API default)"),
  },
  async ({ daysUntil }) => {
    const domains = (await fetchAllPages("/saas/domains")) as Array<
      Record<string, unknown>
    >;

    const params: Record<string, string> = {};
    if (daysUntil !== undefined) params.daysUntil = String(daysUntil);

    const report = await Promise.all(
      domains.map(async (domain) => {
        const id = domain.saasCustomerId as number;
        try {
          const applications = await dattoFetch(`/saas/${id}/applications`, params);
          return { saasCustomerId: id, domain, applications };
        } catch (err) {
          return { saasCustomerId: id, domain, error: (err as Error).message };
        }
      })
    );

    return {
      content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }],
    };
  }
);

// ===========================================================================
// Reporting
// ===========================================================================

// ---- get_activity_log ------------------------------------------------------

server.tool(
  "get_activity_log",
  `GET /v1/report/activity-log
Get a filtered list of activity logs ordered by date.

Filters:
  - clientName : partial/prefix match on client name (e.g. "Pruden")
  - since      : number of time units to look back (default: 1)
  - sinceUnits : days | hours | minutes (default: days)
  - target     : array of "targetType:targetId" tuples (e.g. ["bcdr-device:123"])
  - targetType : filter by target type (e.g. "bcdr-device")
  - user       : partial/prefix match on username

Pagination via _page / _perPage (default 25 per page). Set fetchAll to true
to automatically retrieve all pages.`,
  {
    clientName: z
      .string()
      .optional()
      .describe('Partial/prefix match on client name (e.g. "Pruden")'),
    since: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Number of time units to look back (default: 1)"),
    sinceUnits: z
      .enum(["days", "hours", "minutes"])
      .optional()
      .describe("Unit for the since parameter (default: days)"),
    target: z
      .array(z.string())
      .optional()
      .describe('Array of "targetType:targetId" tuples (e.g. ["bcdr-device:123"])'),
    targetType: z
      .string()
      .optional()
      .describe('Filter by target type (e.g. "bcdr-device")'),
    user: z
      .string()
      .optional()
      .describe("Partial/prefix match on username"),
    page: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Page number (default: 1)"),
    perPage: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Results per page (default: 25)"),
    fetchAll: z
      .boolean()
      .optional()
      .describe("Automatically fetch all pages and return combined results (default: false)"),
  },
  async ({ clientName, since, sinceUnits, target, targetType, user, page, perPage, fetchAll }) => {
    const params: Record<string, string> = {};
    if (clientName) params.clientName = clientName;
    if (since !== undefined) params.since = String(since);
    if (sinceUnits) params.sinceUnits = sinceUnits;
    if (target && target.length > 0) params.target = target.join(",");
    if (targetType) params.targetType = targetType;
    if (user) params.user = user;

    let data: unknown;
    if (fetchAll) {
      data = await fetchAllPages("/report/activity-log", params);
    } else {
      if (page !== undefined) params._page = String(page);
      if (perPage !== undefined) params._perPage = String(perPage);
      data = await dattoFetch("/report/activity-log", params);
    }

    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Datto SaaS MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
