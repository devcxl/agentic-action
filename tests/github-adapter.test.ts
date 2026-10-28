import { describe, expect, it } from "vitest";
import { findMatchingComment, upsertMarkerComment, type GitHubComment } from "@agentic-action/adapters";

describe("GitHub Adapter v2: Full Pagination & Rate-Limit Backoff (P4)", () => {
  it.each([0, 1, 50, 100, 1050])(
    "paginates through %i existing comments without a 10-page cap",
    async (totalComments) => {
      const comments: GitHubComment[] = [];
      for (let i = 1; i <= totalComments; i++) {
        comments.push({
          id: i,
          body:
            i === totalComments && totalComments > 0
              ? "<!-- pi-review:begin -->\nold marker comment\n<!-- pi-review:end -->"
              : `ordinary comment #${i}`,
        });
      }

      const calls: Array<{ url: string; method: string }> = [];
      const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = String(url);
        const method = init?.method ?? "GET";
        calls.push({ url: urlStr, method });

        if (method === "GET") {
          const u = new URL(urlStr);
          const page = Number(u.searchParams.get("page") || "1");
          const perPage = Number(u.searchParams.get("per_page") || "100");
          const start = (page - 1) * perPage;
          const slice = comments.slice(start, start + perPage);
          return new Response(JSON.stringify(slice), { status: 200 });
        }

        if (method === "PATCH") {
          return new Response(
            JSON.stringify({ id: totalComments, html_url: `https://example.com/c/${totalComments}` }),
            { status: 200 },
          );
        }

        return new Response(
          JSON.stringify({ id: 9999, html_url: "https://example.com/c/9999" }),
          { status: 201 },
        );
      }) as typeof fetch;

      const res = await upsertMarkerComment({
        repo: "devcxl/agentic-action",
        pr: 42,
        body: "<!-- pi-review:begin -->\nupdated\n<!-- pi-review:end -->",
        marker: "pi-review",
        token: "ghs_test_token_123456",
        fetchImpl: mockFetch,
        sleepImpl: async () => {},
      });

      if (totalComments === 0) {
        expect(res.action).toBe("created");
        expect(res.commentId).toBe(9999);
      } else {
        expect(res.action).toBe("updated");
        expect(res.commentId).toBe(totalComments);
      }

      if (totalComments === 1050) {
        // 11 GET pages + 1 PATCH
        expect(calls.filter((c) => c.method === "GET")).toHaveLength(11);
      }
    },
  );

  it("retries on HTTP 429 (with Retry-After) and 503 before succeeding", async () => {
    let attempts = 0;
    const sleeps: number[] = [];

    const mockFetch = (async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "1" },
        });
      }
      if (attempts === 2) {
        return new Response("service unavailable", { status: 503 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    }) as typeof fetch;

    const postAwareFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST") {
        return new Response(JSON.stringify({ id: 777, html_url: "https://example.com/777" }), {
          status: 201,
        });
      }
      return mockFetch(url, init);
    }) as typeof fetch;

    const res = await upsertMarkerComment({
      repo: "devcxl/agentic-action",
      pr: 1,
      body: "<!-- pi-review:begin -->\nhello\n<!-- pi-review:end -->",
      token: "ghs_test_token_123456",
      fetchImpl: postAwareFetch,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(res.action).toBe("created");
    expect(attempts).toBe(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]).toBe(1000);
  });

  it("findMatchingComment matches the latest comment with exact marker", () => {
    const list: GitHubComment[] = [
      { id: 1, body: "<!-- pi-review:begin -->first<!-- pi-review:end -->" },
      { id: 2, body: "other bot comment" },
      { id: 3, body: "<!-- pi-review:begin -->latest<!-- pi-review:end -->" },
      { id: 4, body: "another comment without marker" },
    ];
    expect(findMatchingComment(list, "pi-review")?.id).toBe(3);
  });
});
