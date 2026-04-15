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
  params?: Record<string, string>
): Promise<unknown> {
  const url = new URL(`${BASE_URL}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: getAuthHeader(),
      "Content-Type": "application/json",
    },
  });

  if (response.status === 429) {
    // Basic retry after 60 s on rate-limit
    await new Promise((r) => setTimeout(r, 60_000));
    return dattoFetch(path, params);
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
  pageDetails?: { nextPageUrl?: string | null };
};

/**
 * Fetches all pages for list endpoints that use pageDetails.nextPageUrl
 * and returns the aggregated item array.
 */
async function fetchAllPages(
  path: string,
  params?: Record<string, string>
): Promise<unknown[]> {
  const results: unknown[] = [];
  let data = (await dattoFetch(path, params)) as PagedResponse | unknown[];

  function extractItems(d: PagedResponse | unknown[]): unknown[] {
    if (Array.isArray(d)) return d;
    return d.items ?? d.data ?? [];
  }

  results.push(...extractItems(data));

  while (
    !Array.isArray(data) &&
    (data as PagedResponse).pageDetails?.nextPageUrl
  ) {
    const nextUrl = new URL((data as PagedResponse).pageDetails!.nextPageUrl!);
    const nextPath = nextUrl.pathname.replace(/^\/v1/, "");
    const nextParams: Record<string, string> = {};
    nextUrl.searchParams.forEach((v, k) => {
      nextParams[k] = v;
    });
    data = (await dattoFetch(nextPath, nextParams)) as PagedResponse | unknown[];
    results.push(...extractItems(data));
  }

  return results;
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "datto-saas-mcp",
  version: "0.1.0",
});

// ---- list_domains ----------------------------------------------------------

server.tool(
  "list_domains",
  `List all SaaS-protected customer domains managed by the partner.
Returns saasCustomerId and externalSubscriptionId for each domain — both values
are required as inputs to the other reporting tools.
Automatically follows pagination to return all domains.`,
  {},
  async () => {
    const domains = await fetchAllPages("/saas/domains");
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(domains, null, 2),
        },
      ],
    };
  }
);

// ---- list_seats ------------------------------------------------------------

server.tool(
  "list_seats",
  `List all licensed seats for a specific SaaS Protection customer.
Returns one record per seat (User, SharedMailbox, Site, TeamSite, Team,
SharedDrive) including the remoteId (Microsoft 365 / Google object ID) and
protection/licensing status.
Automatically follows pagination to return all seats.`,
  {
    saasCustomerId: z
      .number()
      .int()
      .positive()
      .describe("SaaS Protection customer ID — obtain from list_domains"),
  },
  async ({ saasCustomerId }) => {
    const seats = await fetchAllPages(`/saas/${saasCustomerId}/seats`);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(seats, null, 2),
        },
      ],
    };
  }
);

// ---- get_applications ------------------------------------------------------

server.tool(
  "get_applications",
  `Get the backup application health report for a specific SaaS Protection customer.
This is the primary reporting endpoint. It returns backup success metrics for
each protected application (Exchange, OneDrive, SharePoint, Teams, Google
Workspace services, etc.) including:
  - Seats backed up in the last 24 hours vs. total active seats
  - Seats currently performing initial backup
  - Last complete backup date
  - Day-by-day backup status history for up to 30 days

Use daysUntil to control the size of the history window (default 10 days).`,
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
      .max(30)
      .optional()
      .describe(
        "Days of backup history to include in the report (0–30, default: 10)"
      ),
    includeRemoteID: z
      .boolean()
      .optional()
      .describe(
        "Include Microsoft 365 / Google object IDs in each result (default: false)"
      ),
  },
  async ({ saasCustomerId, daysUntil, includeRemoteID }) => {
    const params: Record<string, string> = {};
    if (daysUntil !== undefined) params.daysUntil = String(daysUntil);
    if (includeRemoteID !== undefined) {
      params.includeRemoteID = includeRemoteID ? "1" : "0";
    }

    const data = await dattoFetch(
      `/saas/${saasCustomerId}/applications`,
      params
    );
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(data, null, 2),
        },
      ],
    };
  }
);

// ---- get_all_applications_report -------------------------------------------

server.tool(
  "get_all_applications_report",
  `Fetch the backup application health report for ALL customer domains in a
single call. Internally calls list_domains and then get_applications for each
domain. Returns an array of objects, each with:
  { saasCustomerId, domainName, applications: [...] }

This is a convenience reporting tool for partners who want a full-fleet
backup status overview without making individual per-customer calls.
Large fleets may take time — consider filtering using list_domains first.`,
  {
    daysUntil: z
      .number()
      .int()
      .min(0)
      .max(30)
      .optional()
      .describe("Days of backup history per domain (0–30, default: 10)"),
    includeRemoteID: z
      .boolean()
      .optional()
      .describe("Include object IDs in results (default: false)"),
  },
  async ({ daysUntil, includeRemoteID }) => {
    const domains = (await fetchAllPages("/saas/domains")) as Array<
      Record<string, unknown>
    >;

    const params: Record<string, string> = {};
    if (daysUntil !== undefined) params.daysUntil = String(daysUntil);
    if (includeRemoteID !== undefined) {
      params.includeRemoteID = includeRemoteID ? "1" : "0";
    }

    const report = await Promise.all(
      domains.map(async (domain) => {
        const id = domain.saasCustomerId as number;
        try {
          const applications = await dattoFetch(
            `/saas/${id}/applications`,
            params
          );
          return {
            saasCustomerId: id,
            domain,
            applications,
          };
        } catch (err) {
          return {
            saasCustomerId: id,
            domain,
            error: (err as Error).message,
          };
        }
      })
    );

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(report, null, 2),
        },
      ],
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
