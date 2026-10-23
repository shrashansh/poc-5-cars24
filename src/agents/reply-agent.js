// ReplyAgent: phrases the other agents' facts. The LLM only writes the sentence; a guard rejects
// anything not in the facts and a template takes over, so the buyer never sees an invented car,
// price or promise.
import { writeReply } from "../reply.js";
import { describe } from "../profile.js";

export const replyAgent = {
  name: "reply",
  after: ["escalation"],
  critical: true,
  async run(ctx) {
    ctx.turn = {
      text: ctx.text, profile: ctx.profile, profileSummary: describe(ctx.profile), changes: ctx.changes, commitments: ctx.commitments,
      answers: ctx.answers, search: ctx.search, needs: ctx.needs, escalation: ctx.escalation, extraction: ctx.extraction,
    };
    ctx.reply = await writeReply(ctx.turn, { store: ctx.services.store, fetchImpl: ctx.services.fetchImpl });
    return ctx.reply.source + (ctx.reply.rejected ? " (LLM reply blocked by guard)" : "");
  },
};
