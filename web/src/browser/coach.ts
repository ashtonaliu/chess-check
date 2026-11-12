// The AI coach in the browser, with the visitor's own Anthropic API key.
// A port of wf/coach.py: same prompt, tools, verifier and repair turn. The key
// goes from this page straight to api.anthropic.com and nowhere else; the
// page has no server.
import { factsText, feedback, verify, type Fact, type Verification } from "./facts";
import type { Row } from "./model";
import type { GameRow } from "./stats";
import { ToolBox, TOOLS } from "./tools";

export const MODEL = "claude-opus-5-5";
const MAX_TOOL_TURNS = 8;

export const SYSTEM = `You are a chess coach writing a short, specific report for one player, based on an analysis of their recent Chess.com games.

Rules (a program checks your report against them):
- Every number, chess move and link you write must come from a fact [F#] or a tool result [T#], and the sentence must cite it, e.g. "... 38% [F3]." Do not round differently, convert units or compute new numbers in your head; if you need a new number, get it with run_sql and cite the result.
- Write moves exactly as they appear in the facts.
- Only call something a weakness if a fact's verdict says "weakness" or "possible weakness", or a model fact shows more blunders than expected. If the evidence is thin, say so plainly.
- Recommendations should be concrete (what to study, which puzzle theme link) but must not invent statistics.

Format (Markdown, under 350 words): a one-sentence summary, then "## Biggest weaknesses" with up to 3 items (evidence, then what to do), then "## What's working" (1-2 items), then "## Training plan" (3-5 bullet points).`;

/** The slice of the SDK the coach uses, so tests can pass a fake. */
export interface CoachClient {
  beta: { messages: { create(params: Record<string, unknown>): Promise<CoachResponse> } };
}
interface Block { type: string; text?: string; id?: string; name?: string; input?: unknown; }
interface CoachResponse { stop_reason: string | null; content: Block[]; usage: { input_tokens: number; output_tokens: number }; }

export interface CoachResult {
  report: string; first_report: string; verification: Verification; first_verification: Verification;
  repaired: boolean; facts: Fact[]; tool_calls: { name: string; input: Record<string, unknown>; error: boolean }[];
  usage: { input_tokens: number; output_tokens: number };
}

export async function makeClient(apiKey: string): Promise<CoachClient> {
  const { default: AnthropicSDK } = await import("@anthropic-ai/sdk");
  // dangerouslyAllowBrowser guards against shipping a *developer's* key to every
  // visitor. Here each visitor supplies their own key, in their own browser.
  return new AnthropicSDK({ apiKey, dangerouslyAllowBrowser: true }) as unknown as CoachClient;
}

export function describeError(e: unknown): string {
  const err = e as { status?: number; message?: string };
  if (err.status === 401) return "Anthropic rejected that API key. Check it and try again.";
  if (err.status === 403) return "That API key isn't allowed to use this model.";
  if (err.status === 429) return "Rate limited by the Anthropic API. Wait a moment and try again.";
  if (err.status === 529) return "The Anthropic API is overloaded right now. Try again shortly.";
  return err.message ?? String(e);
}

export async function runCoach(opts: {
  client: CoachClient; username: string; facts: Fact[]; games: GameRow[]; moves: Row[];
  engineUrl: string; repair?: boolean; onStatus?: (msg: string) => void; summaries?: [string, string][];
}): Promise<CoachResult> {
  const facts = opts.facts.map(f => ({ ...f }));       // tool results get appended
  const box = new ToolBox(opts.games, opts.moves, facts, opts.engineUrl, opts.summaries ?? []);
  const usage = { input_tokens: 0, output_tokens: 0 };
  const messages: Record<string, unknown>[] = [{ role: "user", content:
    `Player: ${opts.username}\n\nFacts:\n${factsText(facts)}\n\nWrite the report. Use the tools if a weakness needs more detail.` }];

  const turns = async (): Promise<CoachResponse> => {
    for (let i = 0; i <= MAX_TOOL_TURNS; i++) {
      const resp = await opts.client.beta.messages.create({
        model: MODEL, max_tokens: 16000, system: SYSTEM, tools: TOOLS, messages,
        output_config: { effort: "medium" },
        betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
      });
      usage.input_tokens += resp.usage?.input_tokens ?? 0;
      usage.output_tokens += resp.usage?.output_tokens ?? 0;
      if (resp.stop_reason === "refusal") throw new Error("The model declined to write this report.");
      messages.push({ role: "assistant", content: resp.content });
      if (resp.stop_reason === "pause_turn") continue;
      const uses = resp.content.filter(b => b.type === "tool_use");
      if (resp.stop_reason !== "tool_use" || !uses.length) return resp;
      const results = [];
      for (const u of uses) {
        opts.onStatus?.(`The coach is using ${(u.name ?? "a tool").replace("_", " ")}…`);
        const { out, isError } = await box.run(u.name!, (u.input ?? {}) as Record<string, unknown>);
        results.push({ type: "tool_result", tool_use_id: u.id, content: out, is_error: isError });
      }
      messages.push({ role: "user", content: results });
    }
    throw new Error("The coach used too many tool calls.");
  };
  const text = (r: CoachResponse) => r.content.filter(b => b.type === "text").map(b => b.text ?? "").join("").trim();

  try {
    opts.onStatus?.("The coach is reading your analysis…");
    let resp = await turns();
    const firstReport = text(resp);
    const first = verify(firstReport, box.facts);
    let report = firstReport, final = first, repaired = false;
    if ((opts.repair ?? true) && !first.ok) {
      opts.onStatus?.(`The checker flagged ${first.unsupported.length + first.bad_citations.length} claim(s); the coach is fixing them…`);
      messages.push({ role: "user", content:
        "A checker found claims in your report that are not supported by any fact or tool result:\n" +
        feedback(first) + "\n\nRewrite the full report fixing only these. Remove a claim rather than guess, " +
        "or look it up with a tool and cite it." });
      resp = await turns();
      report = text(resp);
      final = verify(report, box.facts);
      repaired = true;
    }
    return { report, first_report: firstReport, verification: final, first_verification: first, repaired,
             facts: box.facts, tool_calls: box.calls, usage };
  } finally {
    box.close();
  }
}

/** Opus 5.5 list prices ($4 / $20 per million tokens), for showing the visitor what a report cost. */
export const costUsd = (u: { input_tokens: number; output_tokens: number }) =>
  (u.input_tokens * 4 + u.output_tokens * 20) / 1e6;

