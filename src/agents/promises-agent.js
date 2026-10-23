// PromiseAgent: no promise without an enforcer, and no promise left unchecked.
//   - Turns profile changes into buyer-visible commitments, each naming the system that enforces it.
//   - Confirms preferences the buyer repeats ("already on file") instead of staying silent.
//   - Audits the SearchAgent's output against every standing constraint with its own independent
//     check. A violating car is pulled before the buyer sees it and the violation is traced.
import { commitmentsFor } from "../policy.js";

export function violations(p, car) {
  const v = [];
  if (p.rejectBrands.includes(car.make)) v.push(`rejected brand ${car.make}`);
  if (p.rejectModels.includes(car.model)) v.push(`rejected model ${car.model}`);
  if (p.rejectedIds.includes(car.id)) v.push(`dismissed listing ${car.id}`);
  if (car.body && p.excludeBodies.includes(car.body)) v.push(`excluded body ${car.body}`);
  if (car.fuel && p.excludeFuels.includes(car.fuel)) v.push(`excluded fuel ${car.fuel}`);
  if (p.budgetMax && car.priceLakh > p.budgetMax) v.push(`over budget (${car.priceLakh}L > ${p.budgetMax}L)`);
  return v;
}

export const promiseAgent = {
  name: "promises",
  after: ["search"],
  run(ctx) {
    const { delta: d, changes, profile: p } = ctx;
    const commitments = commitmentsFor(changes);
    if (d.callConsent === false && !changes.some((c) => c.field === "callConsent")) commitments.push({ promise: "No calls from Cars24 (already on file)", enforcedBy: "Dialer suppression flag stays on", check: "dialer" });
    for (const b of d.excludeBodies) if (!changes.some((c) => c.field === "excludeBodies" && c.value === b)) commitments.push({ promise: `No ${b}s (already on file)`, enforcedBy: "Shared intent profile filter stays on", check: "feed" });
    ctx.commitments.push(...commitments);

    if (!ctx.search) return `${ctx.commitments.length} commitment(s); no results to audit`;
    for (const step of ctx.search.steps) {
      step.cars = step.cars.filter((c) => {
        const v = violations(p, c);
        if (v.length) ctx.violations.push({ carId: c.id, title: c.title, step: step.key, problems: v });
        return !v.length;
      });
    }
    if (ctx.violations.length) {
      ctx.search.shown = ctx.search.steps.flatMap((s) => s.cars);
      p.lastShown = ctx.search.shown.slice(0, 10).map((c) => ({ id: c.id, title: `${c.year} ${c.make} ${c.model}`, model: c.model }));
      ctx.emit("promise.violation", ctx.violations, "promises");
    }
    return `${ctx.commitments.length} commitment(s); audited ${ctx.search.shown.length + ctx.violations.length} car(s), ${ctx.violations.length} pulled`;
  },
};
