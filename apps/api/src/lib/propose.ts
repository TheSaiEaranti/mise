/**
 * The ONE way anything in the API turns a mutation into a Proposal (I2):
 * run the tool dry, persist the diff. Chat (in core/agent.ts), drag
 * (POST /api/proposals), and the onboarding wizard (POST /api/semester/proposal)
 * all flow through tool.run(args, 'dry') → createProposal — there is no
 * direct-write shortcut anywhere in this app.
 */
import { createProposal, getDb, type MutationToolDef, type ProposalRow } from '@mise/core';

export async function runDryAndPropose(
  tool: MutationToolDef<unknown>,
  args: Record<string, unknown>,
  user_message?: string,
): Promise<ProposalRow> {
  const result = await tool.run(args, 'dry');
  return createProposal(getDb(), {
    user_message: user_message ?? result.diff.summary,
    tool_name: tool.name,
    tool_args: args,
    diff: result.diff,
    conflicts: result.conflicts,
  });
}
