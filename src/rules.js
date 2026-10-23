// Domain rules that CarGPT escalates today but can answer itself: brand tier, RC transfer, on-road cost.
// RTO steps are indicative; fees vary by state and car age.

export const LUXURY_BRANDS = ["Mercedes-Benz", "BMW", "Audi", "Jaguar", "Volvo", "Land Rover", "Lexus", "Mini", "Porsche", "Maserati"];
export const tierOf = (make) => (LUXURY_BRANDS.includes(make) ? "luxury" : "mass");

export const STATE_CODES = {
  UP: "Uttar Pradesh", DL: "Delhi", HR: "Haryana", MH: "Maharashtra", KA: "Karnataka", RJ: "Rajasthan", MP: "Madhya Pradesh",
  BR: "Bihar", UK: "Uttarakhand", UA: "Uttarakhand", PB: "Punjab", GJ: "Gujarat", TN: "Tamil Nadu", TS: "Telangana", TG: "Telangana",
  WB: "West Bengal", AP: "Andhra Pradesh", KL: "Kerala", CH: "Chandigarh", JH: "Jharkhand", OD: "Odisha", OR: "Odisha",
  HP: "Himachal Pradesh", JK: "Jammu and Kashmir", GA: "Goa", AS: "Assam", CG: "Chhattisgarh",
};

// City → state for cities buyers mention (search cities come from data/cities.json as well).
export const CITY_STATE = {
  kanpur: "Uttar Pradesh", lucknow: "Uttar Pradesh", agra: "Uttar Pradesh", prayagraj: "Uttar Pradesh", allahabad: "Uttar Pradesh",
  varanasi: "Uttar Pradesh", noida: "Uttar Pradesh", "greater noida": "Uttar Pradesh", ghaziabad: "Uttar Pradesh", kannauj: "Uttar Pradesh",
  meerut: "Uttar Pradesh", bareilly: "Uttar Pradesh", gorakhpur: "Uttar Pradesh", aligarh: "Uttar Pradesh", jhansi: "Uttar Pradesh",
  delhi: "Delhi", "new delhi": "Delhi", gurgaon: "Haryana", gurugram: "Haryana", faridabad: "Haryana",
  mumbai: "Maharashtra", pune: "Maharashtra", thane: "Maharashtra", "navi mumbai": "Maharashtra", nagpur: "Maharashtra",
  bangalore: "Karnataka", bengaluru: "Karnataka", mysore: "Karnataka", jaipur: "Rajasthan", udaipur: "Rajasthan",
  hyderabad: "Telangana", chennai: "Tamil Nadu", kolkata: "West Bengal", ahmedabad: "Gujarat", surat: "Gujarat",
  chandigarh: "Chandigarh", indore: "Madhya Pradesh", bhopal: "Madhya Pradesh", patna: "Bihar", dehradun: "Uttarakhand",
  kochi: "Kerala", ludhiana: "Punjab",
};
export const CITY_ALIAS = { bengaluru: "bangalore", gurugram: "gurgaon", delhi: "new delhi", allahabad: "prayagraj" };

const CAP = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());

export function stateOfReg(reg) {
  const m = String(reg || "").toUpperCase().match(/^([A-Z]{2})/);
  return m ? STATE_CODES[m[1]] || null : null;
}

// RC transfer: same state = ownership transfer only; interstate = NOC + re-registration.
export function transferAnswer({ regCode, regState, toCity }, homeCity) {
  const from = regState || stateOfReg(regCode);
  const city = (toCity || homeCity || "").toLowerCase();
  const to = CITY_STATE[city] || null;
  if (!from || !to)
    return { resolved: false, missing: !from ? "registration state (e.g. UP78)" : "the city you'll register the car in", text: `To answer the transfer question I need ${!from ? "the car's registration (e.g. UP78)" : "the city you'll register it in"}.` };
  const label = regCode ? regCode.toUpperCase() : `A ${from}-registered car`;
  if (from === to) return {
    resolved: true, kind: "same-state",
    text: `${label} → ${CAP(city)}: both in ${to}, so it's a same-state ownership transfer. No NOC, no re-registration, no fresh road tax.`,
    steps: ["Form 29 + Form 30 at the registering RTO (Cars24's RC transfer support can file it)", "No NOC and no re-registration within the same state", "If the car has a loan on it: bank NOC + Form 35 first"],
  };
  return {
    resolved: true, kind: "interstate",
    text: `${label} → ${CAP(city)} (${to}): interstate move, so the car needs an NOC from the ${from} RTO and re-registration in ${to}.`,
    steps: [`NOC (Form 28) from the ${from} RTO that registered the car`, "Ownership transfer to you (Form 29/30)", `Re-register in ${to} within 12 months of bringing the car there (Motor Vehicles Act, Sec 47)`, `Pay ${to} road tax on re-registration; claim a pro-rata refund of ${from} road tax`, "If the car has a loan on it: bank NOC + Form 35 first"],
    caveat: "Indicative steps. Fees vary by state and car age; confirm with the destination RTO.",
  };
}

// On-road cost for a specific listing: listed price + what changes with registration state.
export function onRoadAnswer(car, homeCity) {
  const carState = stateOfReg(car.reg);
  const homeState = CITY_STATE[(homeCity || "").toLowerCase()] || null;
  const sameState = carState && homeState && carState === homeState;
  return {
    resolved: true, car,
    text: `${car.year} ${car.make} ${car.model}${car.variant ? ` ${car.variant}` : ""} in ${car.city}: listed at ₹${car.priceLakh}L.`,
    lines: [
      ["Listed price", `₹${car.priceLakh}L`],
      ["Registration", car.reg ? `${car.reg} (${carState || "unknown state"})` : "Not shown on the listing"],
      ["RC transfer", !carState || !homeState ? "Depends on registration state" : sameState ? `Same-state transfer to ${homeCity}: RTO ownership-transfer fee only` : `Interstate: NOC + re-registration + ${homeState} road tax`],
      ["Cars24 RC transfer support", "Paid add-on; fee shown at checkout"],
      ["Inspection report", "Available on the listing"],
    ],
  };
}
