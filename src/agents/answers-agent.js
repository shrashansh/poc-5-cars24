// AnswersAgent: answers RC-transfer and on-road questions from rules and the listing, instead of
// escalating them. Anything it can't resolve is flagged for the EscalationAgent.
import { transferAnswer, onRoadAnswer } from "../rules.js";
import { inventory, findCity } from "../inventory.js";

export const answersAgent = {
  name: "answers",
  after: ["memory"],
  when: (ctx) => Boolean(ctx.delta.transfer || ctx.delta.onRoad),
  run(ctx) {
    const { delta: d, profile: p } = ctx;
    if (d.transfer) {
      const a = transferAnswer(d.transfer, p.homeCity);
      ctx.answers.push({ type: "transfer", ...a });
      if (!a.resolved) ctx.unresolved = ctx.text;
    }
    if (d.onRoad) {
      const car = resolveCar(p, ctx.shownBefore, d.onRoad);
      const a = car ? onRoadAnswer(car, p.homeCity) : { resolved: false, text: `I couldn't find ${d.onRoad.model ? `a ${d.onRoad.model}` : "that car"} in current listings near ${p.homeCity}. Which car do you mean?` };
      ctx.answers.push({ type: "onroad", ...a });
      if (!a.resolved) ctx.unresolved = ctx.text;
    }
    if (ctx.unresolved) ctx.emit("question.unresolved", ctx.unresolved, "answers");
    return ctx.answers.map((a) => `${a.type}:${a.resolved ? a.kind || "resolved" : "unresolved"}`).join(", ");
  },
};

function resolveCar(p, shown, q) {
  let id = null;
  if (q.listingRef && shown[q.listingRef - 1]) id = shown[q.listingRef - 1].id;
  if (!id && q.model) id = shown.find((c) => c.model?.toLowerCase() === q.model.toLowerCase())?.id;
  if (!id && !q.model && shown[0]) id = shown[0].id;
  if (id) return inventory().cars.find((c) => c.id === id) || null;
  if (!q.model) return null;
  const home = findCity(p.homeCity);
  const matches = inventory().cars.filter((c) => c.model?.toLowerCase() === q.model.toLowerCase());
  return matches.find((c) => home && c.citySlug === home.slug) || matches[0] || null;
}
