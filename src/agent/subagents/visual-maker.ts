import { generateText, tool, type LanguageModel, type ModelMessage, type ToolResultPart } from "ai";
import { z } from "zod";
import { modelFor } from "../models.ts";
import type { VisualResult } from "../../core/contracts.ts";
import { getHeadless, type HeadlessApi } from "./headless.ts";

/**
 * The visual-maker sub-agent (vision §2.5): authors ONE precise SVG from a
 * brief, renders it to a PNG in the SAME headless Chrome, LOOKS at the
 * result, and iterates until correct — a direct port of the vault POC's
 * svg-maker doctrine ("the one rule that matters: verify by looking").
 *
 * LOOP SHAPE (decided in the W6 brief): hand-rolled with generateText + a
 * messages array, because the loop must feed an IMAGE back to the model after
 * each render. write_svg / render_svg are declared WITHOUT execute — when the
 * model calls them generateText stops with the tool calls, and this loop
 * appends the tool results itself, followed by a user message containing the
 * rendered PNG as a file part ("Here is the current render"). ToolLoopAgent's
 * execute-tool plumbing can't express that image-in-the-loop shape cleanly.
 *
 * Doctrine enforcement in code: if the model tries to finish while the
 * current SVG has never been rendered (or changed since its last render), the
 * loop renders it anyway, shows the image, and asks the model to look before
 * finishing. Nothing is delivered without having been looked at.
 *
 * Failure semantics mirror the demo-builder: { svg: "", notes: "FAILED: …" }.
 */

export interface VisualMakerInput {
	brief: string;
}

export interface VisualMakerOptions {
	model?: LanguageModel;
	headless?: HeadlessApi;
	/** Max model rounds (write/render cycles + final answer). Default 8. */
	maxIterations?: number;
	/** Live activity-line callback (updates the job record). */
	onActivity?: (line: string) => void;
}

const INSTRUCTIONS = `You are a visual maker — a diagram author + renderer for precise, spatial figures. You
receive a brief describing ONE idea that needs exact placement (coordinate geometry, number lines,
vectors, function plots, physical layouts — things auto-layout diagrams cannot express), and you return
ONE clean, correct SVG. You never see the lesson; the brief is everything you know.

You do NOT decide what idea to show — the teacher already decided. Your job is faithful, precise
composition, and above everything CORRECTNESS: the picture must not assert anything false. A right-angle
mark on the wrong corner, a vector pointing the wrong way, a point plotted at the wrong coordinate is a
failure even if it renders cleanly.

Your two tools:
- write_svg({ svg }) — write the complete <svg>…</svg> source (overwrites the previous version).
- render_svg({}) — rasterize the current SVG in headless Chrome. The render arrives as an image in the
  message right after the tool result.

THE ONE RULE THAT MATTERS MOST: verify by looking. You are done only when you have LOOKED at the
rendered PNG and confirmed it is true to the brief. Rendering success only proves the SVG parsed; it
says nothing about whether the geometry is right or the picture is readable. When you look:

- Is every coordinate, angle, direction, and proportion actually correct? Re-derive the geometry if unsure.
- Are labels placed clearly, not overlapping lines or each other?
- Is anything clipped by the viewBox, too small to read, or cramped?
- Would a learner instantly read the intended idea from this picture alone?

Workflow: plan the coordinate space (viewBox + margins, nothing touching the edges) → write_svg →
render_svg → LOOK critically → fix (write_svg) and re-render until correct and clean. Never finish
without having looked at a render of your FINAL SVG.

SVG requirements:
- A complete <svg> with explicit width/height AND a matching viewBox.
- White background (<rect> or style), dark strokes, sans-serif labels at generous sizes.
- One idea, fewest elements — sparse and large beats busy and tiny.
- Draw only what the brief specifies; never invent data, values, or shapes to fill space.
- Plain, clean styling: at most one accent color. An explanatory diagram, not art.

Your FINAL message: 1-2 sentences of notes for the teacher (what the figure shows, any caveats) —
NEVER the SVG source itself. If you genuinely cannot make a correct picture of the brief, say exactly
that in your final message and why.`;

export function createVisualTools() {
	return {
		write_svg: tool({
			description: "Write the complete SVG source for the figure (overwrites any previous version).",
			inputSchema: z.object({
				svg: z.string().describe('Complete <svg xmlns="…">…</svg> markup.'),
			}),
		}),
		render_svg: tool({
			description: "Render the current SVG to a PNG and show it to you for inspection. No arguments.",
			inputSchema: z.object({}),
		}),
	};
}

const LOOK_MESSAGE =
	"Here is the current render of your SVG — inspect it critically (geometry, labels, clipping, readability):";
const UNLOOKED_FINISH_MESSAGE =
	"You finished without looking at a render of your final SVG. Above is its render. If it is correct and clean, reply with just your notes; otherwise call write_svg with fixes and render again.";

export async function runVisualMaker(input: VisualMakerInput, opts: VisualMakerOptions = {}): Promise<VisualResult> {
	const headless = opts.headless ?? getHeadless();
	const brief = input.brief.trim() || "(no brief)";
	const maxIterations = opts.maxIterations ?? 8;

	const reason = headless.unavailableReason();
	if (reason) {
		return { svg: "", notes: `FAILED: ${reason}` };
	}

	const tools = createVisualTools();
	const prompt = [
		"Brief for ONE precise figure (from the teacher, verbatim — it is everything you know):",
		brief,
		"",
		"Author the SVG, render it, look at it, iterate until correct, then finish with your notes.",
	].join("\n");

	let messages: ModelMessage[] = [{ role: "user", content: prompt }];
	let currentSvg: string | null = null;
	/** The svg shown in the most recent render (null = never rendered). */
	let renderedSvg: string | null = null;
	let finalText = "";

	try {
		for (let iteration = 0; iteration < maxIterations; iteration++) {
			const result = await generateText({ model: opts.model ?? modelFor("visualMaker"), system: INSTRUCTIONS, messages, tools });
			messages = [...messages, ...result.response.messages];

			const toolCalls = result.toolCalls;
			if (toolCalls.length === 0) {
				finalText = result.text.trim();
				// Doctrine gate: never deliver an unlooked SVG. If the current SVG
				// changed since its last render (or was never rendered), show it now
				// and make the model look before accepting the finish.
				if (currentSvg && renderedSvg !== currentSvg) {
					let png: Buffer;
					try {
						png = await headless.renderSvg(currentSvg);
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						return { svg: "", notes: `FAILED: rendering the final SVG failed — ${msg}` };
					}
					opts.onActivity?.("render_svg: inspecting final render");
					renderedSvg = currentSvg;
					messages = [
						...messages,
						{ role: "user", content: [{ type: "file", data: png, mediaType: "image/png" }, { type: "text", text: UNLOOKED_FINISH_MESSAGE }] },
					];
					continue;
				}
				return finish(currentSvg, finalText);
			}

			const toolResults: ToolResultPart[] = [];
			let renderPng: Buffer | null = null; // appended as the image message AFTER the tool results
			for (const call of toolCalls) {
				if (call.toolName === "write_svg") {
					const svg = (call.input as { svg?: unknown }).svg;
					if (typeof svg !== "string" || !svg.includes("<svg")) {
						toolResults.push(toolText(call.toolCallId, call.toolName, "ERROR: expected a complete <svg>…</svg> document in the `svg` field."));
						continue;
					}
					currentSvg = svg;
					opts.onActivity?.(`write_svg: ${(svg.length / 1024).toFixed(1)} KB`);
					toolResults.push(toolText(call.toolCallId, call.toolName, `Saved (${svg.length} bytes). Call render_svg to look at it.`));
				} else if (call.toolName === "render_svg") {
					if (!currentSvg) {
						toolResults.push(toolText(call.toolCallId, call.toolName, "ERROR: nothing to render — call write_svg first."));
						continue;
					}
					try {
						const png = await headless.renderSvg(currentSvg);
						renderPng = png;
						renderedSvg = currentSvg;
						opts.onActivity?.("render_svg: inspecting render");
						toolResults.push(toolText(call.toolCallId, call.toolName, "Rendered — the PNG follows in the next message. Look at it."));
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						opts.onActivity?.("render_svg: render error");
						toolResults.push(toolText(call.toolCallId, call.toolName, `RENDER ERROR (the SVG may be malformed): ${msg}. Fix it with write_svg and render again.`));
					}
				} else {
					toolResults.push(toolText(call.toolCallId, call.toolName, `ERROR: unknown tool "${call.toolName}". Use write_svg or render_svg.`));
				}
			}
			// Message order: assistant tool-calls → tool results → render image.
			messages = [...messages, { role: "tool", content: toolResults }];
			if (renderPng) {
				messages = [
					...messages,
					{
						role: "user",
						content: [
							{ type: "text", text: LOOK_MESSAGE },
							{ type: "file", data: renderPng, mediaType: "image/png" },
						],
					},
				];
			}
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { svg: "", notes: `FAILED: the maker crashed — ${msg}` };
	}

	// Iteration limit: deliver the last written SVG only if it was looked at.
	if (currentSvg && renderedSvg === currentSvg) {
		return { svg: currentSvg, notes: finalText || "Iteration limit reached — delivering the last verified SVG." };
	}
	return { svg: "", notes: `FAILED: iteration limit (${maxIterations}) reached without a verified SVG.` };
}

function toolText(toolCallId: string, toolName: string, value: string): ToolResultPart {
	return { type: "tool-result", toolCallId, toolName, output: { type: "text", value } };
}

function finish(svg: string | null, finalText: string): VisualResult {
	if (!svg) {
		return {
			svg: "",
			notes: `FAILED: the maker never wrote an SVG.${finalText ? ` (${finalText.slice(0, 300)})` : ""}`,
		};
	}
	return { svg, notes: finalText || undefined };
}
