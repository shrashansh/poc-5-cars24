// EscalationAgent: the call gate. A call happens only when the buyer asks; an unresolved question
// goes to async review (or asks first), and the advisor always gets the context packet, including
// what the buyer wants most recently. It reacts the moment the MemoryAgent reports consent revoked,
// cancelling any pending callback before anything else in the turn runs.
import { escalationDecision, contextPacket } from "../policy.js";
import { inventory } from "../inventory.js";
import { newId } from "../store.js";

const now = () => new Date().toISOString();
const openTickets = (ctx) => ctx.services.store.list("tickets", (t) => t.userId === ctx.user.id && t.status === "open");

export const escalationAgent = {
  name: "escalation",
  after: ["answers", "promises"],
  on: {
    "consent.revoked": (ctx) => {
      for (const t of openTickets(ctx).filter((t) => t.callRequested)) {
        ctx.services.store.update("tickets", t.id, (x) => { x.callRequested = false; x.updates.push({ at: now(), text: "Call cancelled: buyer said no calls" }); });
        ctx.cancelledCalls.push(t.id);
      }
    },
  },
  run(ctx) {
    const { profile: p, delta: d, unresolved } = ctx;
    const tickets = openTickets(ctx);
    const esc = escalationDecision(p, { unresolved, openTicket: tickets[0], askedNow: d.callConsent === true });
    let ticket = null;
    if (esc.escalate) ticket = raiseTicket(ctx, { call: esc.call, question: unresolved || (d.callConsent ? ctx.text : null) });
    else if (unresolved && tickets[0]) ctx.services.store.update("tickets", tickets[0].id, (x) => { x.questions.push(unresolved); x.updates.push({ at: now(), text: `Added question: ${unresolved}` }); });
    ctx.escalation = { ...esc, ticketId: ticket?.id || null };
    ctx.ticket = ticket;
    if (ticket) ctx.emit("escalation.raised", { ticketId: ticket.id, call: esc.call }, "escalation");
    return esc.reason;
  },
};

function raiseTicket(ctx, { call, question }) {
  const { store } = ctx.services, u = ctx.user;
  const open = openTickets(ctx)[0];
  const questions = [...new Set([...(open?.questions || []), ...(question ? [question] : [])])];
  const shortlist = (u.profile.lastShown || []).map((s) => inventory().cars.find((c) => c.id === s.id)).filter(Boolean);
  const packet = contextPacket(u, { openQuestions: questions, shortlist, sessionCount: ctx.services.sessionCount(u.id), priorities: ctx.priorities });
  if (open) return store.update("tickets", open.id, (t) => { t.callRequested = t.callRequested || call; t.questions = questions; t.packet = packet; t.updates.push({ at: now(), text: call ? "Buyer asked for a call" : `Question: ${question}` }); });
  const t = { id: newId("tkt"), userId: u.id, sessionId: ctx.sessionId, status: "open", callRequested: call, questions, packet, createdAt: now(), updates: [{ at: now(), text: call ? "Buyer asked for a call" : `Async review: ${question}` }] };
  return store.put("tickets", t.id, t);
}
