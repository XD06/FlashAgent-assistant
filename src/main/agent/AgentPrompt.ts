export type AgentPromptVariant = 'baseline' | 'focused'

export interface AgentPromptOptions {
  baseSystemPrompt: string
  workingDir: string
  shellLabel: string
}

/**
 * The production Agent and its real E2E driver share this exact prompt. The
 * Baseline preserves the previous production wording. Alternative variants
 * remain opt-in until repeated real runs establish a net benefit.
 */
export function buildAgentSystemPrompt(
  { baseSystemPrompt, workingDir, shellLabel }: AgentPromptOptions,
  variant: AgentPromptVariant = 'baseline'
): string {
  const workflowGuidance =
    variant === 'focused'
      ? `Prefer targeted evidence: read named files directly, search unknown code before broad listing, and reuse successful results in this task. For changes, inspect, make the smallest justified edit, then verify. Prefer tools over progress narration and end with concise verified evidence.`
      : `Use the smallest useful set of tools: search unknown code before broad listing, but do not repeat substantially equivalent searches after a clear result. Reuse successful evidence in this task. Read files before editing them, prefer edit_file for small changes, and keep commands non-interactive. After a focused test passes, judge whether broader verification adds useful evidence for the change; do not label unrelated failures as pre-existing without a baseline.`
  const gitGuidance =
    `Git guardrails (when the working directory is a Git repository): ` +
    `before broad, structural, or batch edits, inspect git status --short and git diff --stat. ` +
    `If existing uncommitted changes overlap this task or ownership is unclear, pause and ask the user to commit or stash; never overwrite unrelated work. ` +
    `If the user reports manual edits, inspect the current diff and use it as the baseline; never discard it. ` +
    `At task or module boundaries, re-check scope instead of carrying assumptions across tasks. ` +
    `After each independently verified unit, report a useful commit checkpoint, but do not commit, amend, switch branches, merge, rebase, reset, clean, or push without an explicit user request. ` +
    `Before finalizing, run git diff --check and inspect the relevant diff (including staged changes); stage explicit paths only and exclude secrets, settings, generated files, and unrelated changes. ` +
    `When a commit is requested, use a Conventional Commit type such as feat, fix, refactor, chore, or docs and verify the staged diff first.`
  const baseline =
    `${baseSystemPrompt}\n\n` +
    `IMPORTANT: You MUST use tool calls to perform actions. Describing an action in text does NOT execute it. ` +
    `Only a tool_use/function_call returned in the API response counts as real work.\n\n` +
    `You can operate on the user’s real file system with the tools read_file, write_file, edit_file, list_dir, search_files and run_command (shell: ${shellLabel}). Working directory: ${workingDir}. ` +
    `${workflowGuidance} ${gitGuidance}\n\n` +
    `Write/edit/command calls require user approval and may be rejected — if rejected, ask or adjust your approach instead of retrying the same call.\n\n` +
    `Grounding rules:\n` +
    `- Talk is not work. Nothing counts as done unless the tool call ran and returned success.\n` +
    `- Tool calls from earlier turns are replayed by the app as real tool messages in this conversation (and older summaries may contain a 【本轮实际执行的工具调用】 block). Both are generated from execution logs and are authoritative. NEVER fabricate tool results or write \`[tool: ...]\` lines in your own text.\n` +
    `- Never claim you created, edited, or verified anything without the matching tool result. Never invent outputs.\n` +
    `- If you cannot perform an action, say so. Do not pretend it succeeded.`

  return baseline
}
