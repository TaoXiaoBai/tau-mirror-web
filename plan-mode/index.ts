/**
 * Plan Mode Extension
 *
 * Read-only exploration mode for safe code analysis.
 * When enabled, built-in write tools are disabled.
 *
 * Features:
 * - /plan command or Ctrl+Alt+P to toggle
 * - Bash restricted to allowlisted read-only commands
 * - Extracts numbered plan steps from "Plan:" sections
 * - [DONE:n] markers to complete steps during execution
 * - Progress tracking widget during execution
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { extractTodoItems, isSafeCommand, markCompletedSteps, type TodoItem } from "./utils.ts";

// Tools
const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire"];
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];
const PLAN_MODE_DISABLED_TOOLS = new Set<string>(["edit", "write"]);
const PLAN_MANAGED_TOOLS = new Set<string>([...PLAN_MODE_TOOLS, ...NORMAL_MODE_TOOLS]);

interface PlanModeState {
	enabled: boolean;
	todos?: TodoItem[];
	executing?: boolean;
	awaitingAction?: boolean;
	toolsBeforePlanMode?: string[];
}

type PlanModeAction = "get_state" | "enable" | "disable" | "toggle" | "execute" | "stay" | "refine" | "pause_for_model_switch" | "resume";

interface PlanModeControl {
	action?: PlanModeAction;
	requestId?: string;
	instruction?: string;
}

// Type guard for assistant messages
function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

// Extract text content from an assistant message
function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let executionMode = false;
	let todoItems: TodoItem[] = [];
	let awaitingAction = false;
	let toolsBeforePlanMode: string[] | undefined;
	let activeCtx: ExtensionContext | null = null;
	let webClientCount = 0;
	let executionContinuationPending = false;
	let executionNoProgressTurns = 0;

	// Publish a complete, authoritative snapshot. requestId lets Tau distinguish
	// a confirmed state transition from an unrelated progress update.
	function emitPlanModeState(requestId?: string, error?: string): void {
		pi.events.emit("tau-plan-mode:state", {
			available: true,
			mode: executionMode ? "executing" : planModeEnabled ? "planning" : "off",
			enabled: planModeEnabled,
			executing: executionMode,
			awaitingAction,
			todos: todoItems.map((item) => ({ ...item })),
			requestId,
			...(error ? { error } : {}),
		});
	}

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	function updateStatus(ctx: ExtensionContext | null): void {
		// Footer status (only when a TUI context is available)
		if (ctx?.hasUI) {
			if (executionMode && todoItems.length > 0) {
			const completed = todoItems.filter((t) => t.completed).length;
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `📋 ${completed}/${todoItems.length}`));
		} else if (planModeEnabled) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "⏸ plan"));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}

		// Widget showing todo list
		if (executionMode && todoItems.length > 0) {
			const lines = todoItems.map((item) => {
				if (item.completed) {
					return (
						ctx.ui.theme.fg("success", "☑ ") + ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text))
					);
				}
				return `${ctx.ui.theme.fg("muted", "☐ ")}${item.text}`;
			});
			ctx.ui.setWidget("plan-todos", lines);
		} else {
				ctx.ui.setWidget("plan-todos", undefined);
			}
		}
		emitPlanModeState();
	}

	function uniqueToolNames(toolNames: string[]): string[] {
		return [...new Set(toolNames)];
	}

	function getPlanModeTools(activeToolNames: string[]): string[] {
		return uniqueToolNames([
			...activeToolNames.filter((name) => !PLAN_MODE_DISABLED_TOOLS.has(name)),
			...PLAN_MODE_TOOLS,
		]);
	}

	function getNormalModeTools(activeToolNames: string[]): string[] {
		return uniqueToolNames([
			...NORMAL_MODE_TOOLS,
			...activeToolNames.filter((name) => !PLAN_MANAGED_TOOLS.has(name)),
		]);
	}

	function enablePlanModeTools(): void {
		if (toolsBeforePlanMode === undefined) {
			toolsBeforePlanMode = pi.getActiveTools();
		}
		pi.setActiveTools(getPlanModeTools(toolsBeforePlanMode));
	}

	function restoreNormalModeTools(): void {
		pi.setActiveTools(toolsBeforePlanMode ?? getNormalModeTools(pi.getActiveTools()));
		toolsBeforePlanMode = undefined;
	}

	function continueExecution(): void {
		if (!executionMode || executionContinuationPending) return;
		const remaining = todoItems.filter((item) => !item.completed);
		if (remaining.length === 0) return;
		executionContinuationPending = true;
		const remainingList = remaining.map((item) => `${item.step}. ${item.text}`).join("\n");
		const next = remaining[0];
		pi.sendMessage(
			{
				customType: "plan-mode-continue",
				content: `Continue executing the plan without waiting for the user.\n\nRemaining steps:\n${remainingList}\n\nProceed with the next incomplete step now: ${next.text}\nContinue through subsequent steps in order when possible. After completing each step, include its [DONE:n] marker.`,
				display: false,
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		// The flag only prevents duplicate scheduling in the same event cycle.
		// It is cleared when the next turn starts.
	}

	function persistState(): void {
		pi.appendEntry("plan-mode", {
			enabled: planModeEnabled,
			todos: todoItems,
			executing: executionMode,
			awaitingAction,
			toolsBeforePlanMode,
		});
	}

	function setPlanMode(enabled: boolean, ctx: ExtensionContext | null, notify = true): void {
		if (enabled === planModeEnabled && !executionMode) return;
		planModeEnabled = enabled;
		executionMode = false;
		executionContinuationPending = false;
		executionNoProgressTurns = 0;
		awaitingAction = false;
		if (!enabled) todoItems = [];

		if (enabled) {
			enablePlanModeTools();
			if (notify) ctx?.ui.notify?.("Plan mode enabled. Built-in write tools disabled.");
		} else {
			restoreNormalModeTools();
			if (notify) ctx?.ui.notify?.("Plan mode disabled. Full access restored.");
		}
		updateStatus(ctx);
		persistState();
	}

	function togglePlanMode(ctx: ExtensionContext | null): void {
		setPlanMode(!planModeEnabled || executionMode, ctx);
	}

	pi.registerCommand("plan", {
		description: "Toggle plan mode (read-only exploration)",
		handler: async (_args, ctx) => togglePlanMode(ctx),
	});

	pi.registerCommand("todos", {
		description: "Show current plan todo list",
		handler: async (_args, ctx) => {
			if (todoItems.length === 0) {
				ctx.ui.notify("No todos. Create a plan first with /plan", "info");
				return;
			}
			const list = todoItems.map((item, i) => `${i + 1}. ${item.completed ? "✓" : "○"} ${item.text}`).join("\n");
			ctx.ui.notify(`Plan Progress:\n${list}`, "info");
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});

	// Tau web control protocol. Actions are idempotent and every request receives
	// an authoritative state response, avoiding front/back-end toggle races.
	pi.events.on("tau-plan-mode:clients", (value: unknown) => {
		webClientCount = Math.max(0, Number(value) || 0);
	});
	pi.events.on("tau-plan-mode:request-state", (payload: unknown) => {
		emitPlanModeState((payload as { requestId?: string } | undefined)?.requestId);
	});
	pi.events.on("tau-plan-mode:toggle", () => togglePlanMode(activeCtx));
	pi.events.on("tau-plan-mode:control", (payload: unknown) => {
		const control = (payload || {}) as PlanModeControl;
		const action = control.action || "get_state";
		let error = "";
		try {
			if (action === "enable") setPlanMode(true, activeCtx, false);
			else if (action === "disable") setPlanMode(false, activeCtx, false);
			else if (action === "toggle") togglePlanMode(activeCtx);
			else if (action === "stay") {
				if (!planModeEnabled) throw new Error("Plan mode is not active");
				awaitingAction = false;
				updateStatus(activeCtx);
				persistState();
			} else if (action === "execute") {
				if (!planModeEnabled || todoItems.length === 0) throw new Error("There is no plan to execute yet");
				const firstTodoItem = todoItems[0];
				planModeEnabled = false;
				executionMode = true;
				executionContinuationPending = false;
				executionNoProgressTurns = 0;
				awaitingAction = false;
				restoreNormalModeTools();
				updateStatus(activeCtx);
				persistState();
				const remainingList = todoItems.map((t) => `${t.step}. ${t.text}`).join("\n");
				pi.sendMessage({
					customType: "plan-mode-execute",
					content: `Execute the entire plan.\n\nRemaining steps:\n${remainingList}\n\nStart with: ${firstTodoItem.text}\nContinue automatically through every remaining step; do not stop to ask the user to type \"continue\" between steps. After completing each step, include its [DONE:n] marker.`,
					display: true,
				}, { triggerTurn: true, deliverAs: "followUp" });
			} else if (action === "refine") {
				const instruction = String(control.instruction || "").trim();
				if (!planModeEnabled || todoItems.length === 0) throw new Error("There is no plan to refine yet");
				if (!instruction) throw new Error("Refinement instructions are empty");
				awaitingAction = false;
				persistState();
				pi.sendUserMessage(`Refine the current plan using these instructions:\n${instruction}`, { deliverAs: "followUp" });
			} else if (action === "pause_for_model_switch") {
				if (!planModeEnabled && !executionMode) throw new Error("Plan mode is not active");
				// Prevent agent_settled from scheduling the normal automatic next
				// execution turn while Tau is waiting to install the new model.
				executionContinuationPending = true;
				executionNoProgressTurns = 0;
				awaitingAction = false;
				persistState();
			} else if (action === "resume") {
				// A model hot-switch aborts only the active provider turn. Preserve
				// the current plan/progress and continue on the newly selected model.
				if (!planModeEnabled && !executionMode) throw new Error("Plan mode is not active");
				awaitingAction = false;
				executionContinuationPending = true;
				// An aborted partial turn has no reliable [DONE:n] marker; do not
				// count it toward the no-progress safety pause.
				executionNoProgressTurns = 0;
				persistState();
				if (executionMode) {
					const remaining = todoItems.filter((item) => !item.completed);
					if (remaining.length === 0) throw new Error("The plan has no remaining steps");
					const remainingList = remaining.map((item) => `${item.step}. ${item.text}`).join("\n");
					pi.sendMessage({
						customType: "plan-mode-model-resume",
						content: `Continue executing the existing plan with the newly selected model.\n\nRemaining steps:\n${remainingList}\n\nResume from the first unfinished step. Preserve completed steps, continue automatically, and include [DONE:n] after completing each remaining step.`,
						display: true,
					}, { triggerTurn: true, deliverAs: "followUp" });
				} else {
					const existingPlan = todoItems.length
						? `\n\nCurrent draft steps:\n${todoItems.map((item) => `${item.step}. ${item.text}`).join("\n")}`
						: "";
					pi.sendUserMessage(
						`Continue the current read-only planning task with the newly selected model. Re-check the conversation and continue from where the interrupted turn stopped.${existingPlan}`,
						{ deliverAs: "followUp" },
					);
				}
			}
		} catch (err: any) {
			error = err?.message || String(err);
		}
		emitPlanModeState(control.requestId, error || undefined);
	});

	// Block destructive bash commands in plan mode
	pi.on("tool_call", async (event) => {
		if (!planModeEnabled || event.toolName !== "bash") return;

		const command = event.input.command as string;
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `Plan mode: command blocked (not allowlisted). Use /plan to disable plan mode first.\nCommand: ${command}`,
			};
		}
	});

	// Filter out stale plan mode context when not in plan mode
	pi.on("context", async (event) => {
		if (planModeEnabled) return;

		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				if (msg.customType === "plan-mode-context") return false;
				if (msg.role !== "user") return true;

				const content = msg.content;
				if (typeof content === "string") {
					return !content.includes("[PLAN MODE ACTIVE]");
				}
				if (Array.isArray(content)) {
					return !content.some(
						(c) => c.type === "text" && (c as TextContent).text?.includes("[PLAN MODE ACTIVE]"),
					);
				}
				return true;
			}),
		};
	});

	// Inject plan/execution context before agent starts
	pi.on("before_agent_start", async () => {
		if (planModeEnabled) {
			return {
				message: {
					customType: "plan-mode-context",
					content: `[PLAN MODE ACTIVE]
You are in plan mode - a read-only exploration mode for safe code analysis.

Restrictions:
- Built-in edit and write tools are disabled
- Other currently active tools remain available
- Bash is restricted to an allowlist of read-only commands

Ask clarifying questions using the questionnaire tool.
Use brave-search skill via bash for web research.

Create a detailed numbered plan under a "Plan:" header:

Plan:
1. First step description
2. Second step description
...

Do NOT attempt to make changes - just describe what you would do.`,
					display: false,
				},
			};
		}

		if (executionMode && todoItems.length > 0) {
			const remaining = todoItems.filter((t) => !t.completed);
			const todoList = remaining.map((t) => `${t.step}. ${t.text}`).join("\n");
			return {
				message: {
					customType: "plan-execution-context",
					content: `[EXECUTING PLAN - Full tool access enabled]

Remaining steps:
${todoList}

Execute every remaining step in order.
Continue automatically between steps; do not wait for a user message.
After completing each step, include its [DONE:n] marker.`,
					display: false,
				},
			};
		}
	});

	pi.on("turn_start", async () => {
		if (executionContinuationPending) executionContinuationPending = false;
		else if (executionMode) executionNoProgressTurns = 0;
	});

	// Track progress after each turn
	pi.on("turn_end", async (event, ctx) => {
		if (!executionMode || todoItems.length === 0) return;
		if (!isAssistantMessage(event.message)) return;

		const text = getTextContent(event.message);
		if (markCompletedSteps(text, todoItems) > 0) {
			executionNoProgressTurns = 0;
			updateStatus(ctx);
		} else {
			executionNoProgressTurns += 1;
		}
		persistState();
	});

	// A completed assistant response ends a normal Pi run even when plan steps
	// remain. Once Pi is truly idle, schedule the next execution turn ourselves.
	pi.on("agent_settled", async (_event, ctx) => {
		if (!executionMode || todoItems.length === 0) return;
		if (todoItems.every((t) => t.completed)) {
			const completedList = todoItems.map((t) => `~~${t.text}~~`).join("\n");
			pi.sendMessage(
				{ customType: "plan-complete", content: `**Plan Complete!** ✓\n\n${completedList}`, display: true },
				{ triggerTurn: false },
			);
			executionMode = false;
			executionContinuationPending = false;
			executionNoProgressTurns = 0;
			awaitingAction = false;
			todoItems = [];
			updateStatus(ctx);
			persistState();
			return;
		}
		// Avoid an unbounded paid loop if a model repeatedly ignores progress
		// markers. Normal successful steps reset this counter in turn_end.
		if (executionNoProgressTurns >= 3) {
			pi.sendMessage(
				{
					customType: "plan-mode-paused",
					content: "Plan execution paused because three consecutive turns did not report a [DONE:n] progress marker. Review the last result, then resume when ready.",
					display: true,
				},
				{ triggerTurn: false },
			);
			executionMode = false;
			executionContinuationPending = false;
			awaitingAction = false;
			updateStatus(ctx);
			persistState();
			return;
		}
		continueExecution();
	});

	// Handle plan creation and plan mode UI
	pi.on("agent_end", async (event, ctx) => {
		if (executionMode) return;

		if (!planModeEnabled || !ctx.hasUI) return;

		// Extract todos from last assistant message
		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		if (lastAssistant) {
			const extracted = extractTodoItems(getTextContent(lastAssistant));
			if (extracted.length > 0) {
				todoItems = extracted;
			}
		}

		if (todoItems.length === 0) return;
		awaitingAction = true;
		updateStatus(ctx);
		persistState();

		// The web owns this choice while connected. It renders the same actions
		// without relying on the terminal-only ctx.ui.select implementation.
		if (webClientCount > 0) return;

		// Show plan steps and prompt for next action
		const todoListText = todoItems.map((t, i) => `${i + 1}. ☐ ${t.text}`).join("\n");
		const planTodoListMessage = {
			customType: "plan-todo-list",
			content: `**Plan Steps (${todoItems.length}):**\n\n${todoListText}`,
			display: true,
		};

		const choice = await ctx.ui.select("Plan mode - what next?", [
			"Execute the plan (track progress)",
			"Stay in plan mode",
			"Refine the plan",
		]);

		if (choice?.startsWith("Execute")) {
			const firstTodoItem = todoItems[0];
			if (!firstTodoItem) return;

			planModeEnabled = false;
			executionMode = true;
			executionContinuationPending = false;
			executionNoProgressTurns = 0;
			awaitingAction = false;
			restoreNormalModeTools();
			updateStatus(ctx);
			persistState();

			const remainingList = todoItems.map((t) => `${t.step}. ${t.text}`).join("\n");
			const execMessage = `Execute the entire plan.

Remaining steps:
${remainingList}

Start with: ${firstTodoItem.text}
Continue automatically through every remaining step; do not stop to ask the user to type "continue" between steps.
After completing each step, include its [DONE:n] marker.`;
			pi.sendMessage(planTodoListMessage, { deliverAs: "followUp" });
			pi.sendMessage(
				{ customType: "plan-mode-execute", content: execMessage, display: true },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} else if (choice === "Refine the plan") {
			const refinement = await ctx.ui.editor("Refine the plan:", "");
			if (refinement?.trim()) {
				awaitingAction = false;
				persistState();
				pi.sendMessage(planTodoListMessage, { deliverAs: "followUp" });

				pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
			}
		}
	});

	// Restore state on session start/resume
	pi.on("session_start", async (_event, ctx) => {
		activeCtx = ctx;
		if (pi.getFlag("plan") === true) {
			planModeEnabled = true;
		}

		const entries = ctx.sessionManager.getEntries();

		// Restore persisted state
		const planModeEntry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode")
			.pop() as { data?: PlanModeState } | undefined;

		if (planModeEntry?.data) {
			planModeEnabled = planModeEntry.data.enabled ?? planModeEnabled;
			todoItems = planModeEntry.data.todos ?? todoItems;
			executionMode = planModeEntry.data.executing ?? executionMode;
			awaitingAction = planModeEntry.data.awaitingAction ?? awaitingAction;
			toolsBeforePlanMode = planModeEntry.data.toolsBeforePlanMode ?? toolsBeforePlanMode;
		}

		// On resume: re-scan messages to rebuild completion state
		// Only scan messages AFTER the last "plan-mode-execute" to avoid picking up [DONE:n] from previous plans
		const isResume = planModeEntry !== undefined;
		if (isResume && executionMode && todoItems.length > 0) {
			// Find the index of the last plan-mode-execute entry (marks when current execution started)
			let executeIndex = -1;
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i] as { type: string; customType?: string };
				if (entry.customType === "plan-mode-execute") {
					executeIndex = i;
					break;
				}
			}

			// Only scan messages after the execute marker
			const messages: AssistantMessage[] = [];
			for (let i = executeIndex + 1; i < entries.length; i++) {
				const entry = entries[i];
				if (entry.type === "message" && "message" in entry && isAssistantMessage(entry.message as AgentMessage)) {
					messages.push(entry.message as AssistantMessage);
				}
			}
			const allText = messages.map(getTextContent).join("\n");
			markCompletedSteps(allText, todoItems);
		}

		if (planModeEnabled) {
			enablePlanModeTools();
		}
		updateStatus(ctx);
	});
}
