/**
 * The fixed cast of the partner world: commodities from FDA's Food Traceability
 * List, the firms that move them and their locations. Names are fictional. The
 * cast is the same for every seed; the seed drives field counts, store
 * assortments and all activity.
 */

export const COMMODITY_IDS = [
  "romaine", "cucumbers", "cantaloupe", "bell_peppers", "tomatoes",
  "cilantro", "sprouts", "soft_cheese", "shell_eggs", "finfish",
] as const;
export type CommodityId = (typeof COMMODITY_IDS)[number];

export type Supply =
  | { kind: "grown"; everyDays: [number, number]; cases: [number, number] }
  | { kind: "direct"; vendorId: string; weekdays: number[]; cases: [number, number] };

export interface Commodity {
  id: CommodityId;
  /** Plain name used in notices ("romaine lettuce"). */
  name: string;
  /** Food Traceability List category. */
  ftlCategory: string;
  /** Item description as the distributor's WMS prints it. */
  productDesc: string;
  /** Product description as a recalling firm would write it. */
  noticeProduct: string;
  caseWeightLb: number;
  supply: Supply;
  /** Share of retail stores that carry the item. */
  stockShare: number;
}

export const COMMODITIES: Record<CommodityId, Commodity> = {
  romaine: {
    id: "romaine", name: "romaine lettuce", ftlCategory: "Leafy greens (fresh)",
    productDesc: "ROMAINE HEARTS 12/3CT", noticeProduct: "Romaine lettuce hearts, 3-count bags, packed 12 bags per case",
    caseWeightLb: 22, supply: { kind: "grown", everyDays: [3, 4], cases: [140, 240] }, stockShare: 1,
  },
  cucumbers: {
    id: "cucumbers", name: "cucumbers", ftlCategory: "Cucumbers (fresh)",
    productDesc: "CUCUMBER SELECT 24CT", noticeProduct: "Fresh whole slicer cucumbers, 24-count cartons",
    caseWeightLb: 28, supply: { kind: "grown", everyDays: [2, 3], cases: [90, 170] }, stockShare: 1,
  },
  cantaloupe: {
    id: "cantaloupe", name: "cantaloupe", ftlCategory: "Melons (fresh)",
    productDesc: "CANTALOUPE 9CT", noticeProduct: "Whole cantaloupe, 9-count cartons",
    caseWeightLb: 40, supply: { kind: "grown", everyDays: [3, 4], cases: [80, 160] }, stockShare: 0.85,
  },
  bell_peppers: {
    id: "bell_peppers", name: "green bell peppers", ftlCategory: "Peppers (fresh)",
    productDesc: "PEPPER BELL GRN XL 25#", noticeProduct: "Green bell peppers, extra large, 25 lb cartons",
    caseWeightLb: 25, supply: { kind: "grown", everyDays: [3, 5], cases: [90, 160] }, stockShare: 1,
  },
  tomatoes: {
    id: "tomatoes", name: "Roma tomatoes", ftlCategory: "Tomatoes (fresh)",
    productDesc: "TOMATO ROMA 25#", noticeProduct: "Fresh Roma tomatoes, 25 lb cartons",
    caseWeightLb: 25, supply: { kind: "grown", everyDays: [2, 4], cases: [110, 200] }, stockShare: 1,
  },
  cilantro: {
    id: "cilantro", name: "fresh cilantro", ftlCategory: "Herbs (fresh)",
    productDesc: "CILANTRO 30CT BNCH", noticeProduct: "Fresh cilantro, bunched, 30 bunches per case",
    caseWeightLb: 18, supply: { kind: "grown", everyDays: [3, 4], cases: [60, 130] }, stockShare: 0.75,
  },
  sprouts: {
    id: "sprouts", name: "alfalfa sprouts", ftlCategory: "Sprouts (fresh)",
    productDesc: "SPROUTS ALFALFA 12/4OZ", noticeProduct: "Alfalfa sprouts, 4 oz clamshells, 12 per case",
    caseWeightLb: 4, supply: { kind: "grown", everyDays: [2, 2], cases: [35, 80] }, stockShare: 0.45,
  },
  soft_cheese: {
    id: "soft_cheese", name: "queso fresco", ftlCategory: "Cheeses, other than hard cheeses",
    productDesc: "QUESO FRESCO 12/10OZ", noticeProduct: "Queso fresco soft cheese, 10 oz rounds, 12 per case",
    caseWeightLb: 8, supply: { kind: "direct", vendorId: "ARC", weekdays: [1, 4], cases: [28, 60] }, stockShare: 0.55,
  },
  shell_eggs: {
    id: "shell_eggs", name: "shell eggs", ftlCategory: "Shell eggs",
    productDesc: "EGGS LG WHT GR-A 15DZ", noticeProduct: "Large white Grade A shell eggs, 15 dozen cases",
    caseWeightLb: 23, supply: { kind: "direct", vendorId: "SER", weekdays: [2, 5], cases: [50, 95] }, stockShare: 1,
  },
  finfish: {
    id: "finfish", name: "Atlantic salmon fillets", ftlCategory: "Finfish (fresh)",
    productDesc: "SALMON ATL FILLET FRSH 10#", noticeProduct: "Fresh farmed Atlantic salmon fillets, 10 lb cases",
    caseWeightLb: 10, supply: { kind: "direct", vendorId: "CSS", weekdays: [1, 3, 5], cases: [18, 40] }, stockShare: 0.4,
  },
};

export interface Grower {
  firmId: string;
  /** Two-digit farm code printed in grower lot codes. */
  code: string;
  name: string;
  city: string;
  state: string;
  locationId: string;
  /** Field commodities in field order; the seed decides how many are planted, within `fieldCount`. */
  fieldPalette: CommodityId[];
  fieldCount: [number, number];
  /** Where harvest lots are cooled: on the farm, or at the packer's cooler. */
  coolsAt: "farm" | "packer";
  coolerName: string;
}

export const GROWERS: Grower[] = [
  {
    firmId: "GRW12", code: "12", name: "Palomar Flats Farms", city: "Salinas", state: "CA", locationId: "FARM12",
    fieldPalette: ["romaine", "cilantro", "romaine", "cilantro"], fieldCount: [3, 4], coolsAt: "farm", coolerName: "Palomar Flats vacuum cooler 1",
  },
  {
    firmId: "GRW27", code: "27", name: "Tule Bend Growers", city: "Oxnard", state: "CA", locationId: "FARM27",
    fieldPalette: ["tomatoes", "bell_peppers", "tomatoes", "bell_peppers"], fieldCount: [2, 4], coolsAt: "packer", coolerName: "Halvard forced-air bay 2",
  },
  {
    firmId: "GRW31", code: "31", name: "Mesa Dorada Ranch", city: "Yuma", state: "AZ", locationId: "FARM31",
    fieldPalette: ["cantaloupe", "cucumbers", "cantaloupe", "romaine"], fieldCount: [2, 4], coolsAt: "farm", coolerName: "Mesa Dorada hydrocooler",
  },
  {
    firmId: "GRW44", code: "44", name: "Kettle Hollow Growers", city: "Watsonville", state: "CA", locationId: "FARM44",
    fieldPalette: ["sprouts", "romaine", "cucumbers", "sprouts"], fieldCount: [2, 4], coolsAt: "packer", coolerName: "Halvard forced-air bay 4",
  },
];

export const PACKER = {
  firmId: "PKR01", name: "Halvard Cooling & Pack Co.", city: "Salinas", state: "CA", locationId: "PACK01",
  address: "1180 Abbott St",
};

export const DISTRIBUTOR = {
  firmId: "NGP", name: "Northgate Produce", city: "West Sacramento", state: "CA", locationId: "DC01",
  dcName: "Northgate Produce DC", address: "2400 Industrial Blvd",
};

/** A packer customer outside the traced network: its share of a lot never reaches Northgate. */
export const EXTERNAL_CUSTOMER = {
  firmId: "BAY", name: "Bayline Foodservice", city: "Stockton", state: "CA", locationId: "BAY01", address: "77 Port Rd",
};

export interface DirectVendor {
  firmId: string;
  name: string;
  city: string;
  state: string;
  locationId: string;
  commodity: CommodityId;
}

export const DIRECT_VENDORS: DirectVendor[] = [
  { firmId: "ARC", name: "Alder Run Creamery", city: "Petaluma", state: "CA", locationId: "ARC01", commodity: "soft_cheese" },
  { firmId: "SER", name: "Sixmile Egg Ranch", city: "Turlock", state: "CA", locationId: "SER01", commodity: "shell_eggs" },
  { firmId: "CSS", name: "Cold Sound Seafood", city: "Eureka", state: "CA", locationId: "CSS01", commodity: "finfish" },
];

export interface Carrier {
  id: string;
  name: string;
  scac: string;
  city: string;
  state: string;
}

export const CARRIERS: Carrier[] = [
  { id: "RRL", name: "Redline Reefer Lines", scac: "RRLX", city: "Fresno", state: "CA" },
  { id: "OCF", name: "Ostrom Cold Freight", scac: "OSCF", city: "Modesto", state: "CA" },
];

/** How a chain's receiving system writes the supplier lot it scans off the case. */
export type LotStyle = "plain" | "lower" | "truncate";

export interface Chain {
  id: string;
  name: string;
  lotStyle: LotStyle;
  /** Delivery days, 0 = Sunday. */
  weekdays: number[];
  /** First chain-internal store number; stores count up from here. */
  storeNoBase: number;
  state: string;
  cities: string[];
}

export const CHAINS: Chain[] = [
  {
    id: "HBR", name: "Harbor Foods", lotStyle: "plain", weekdays: [1, 3, 5], storeNoBase: 201, state: "CA",
    cities: ["Monterey", "Santa Cruz", "Watsonville", "Salinas", "Seaside", "Gilroy", "Hollister", "Marina", "Carmel"],
  },
  {
    id: "PPG", name: "Pine & Prairie Grocers", lotStyle: "lower", weekdays: [2, 4, 6], storeNoBase: 310, state: "CA",
    cities: ["Davis", "Woodland", "Roseville", "Folsom", "Elk Grove", "Lodi", "Auburn", "Rocklin"],
  },
  {
    id: "CBK", name: "Corner Basket", lotStyle: "truncate", weekdays: [1, 4, 6], storeNoBase: 12, state: "CA",
    cities: ["Oakland", "Berkeley", "Fremont", "Hayward", "San Leandro", "Richmond", "Vallejo", "Concord"],
  },
  {
    id: "LKV", name: "Lakeview Markets", lotStyle: "plain", weekdays: [2, 5], storeNoBase: 501, state: "NV",
    cities: ["Reno", "Sparks", "Carson City", "South Lake Tahoe", "Truckee", "Minden", "Fernley"],
  },
];

export interface FoodServiceAccount {
  firmId: string;
  locationId: string;
  name: string;
  city: string;
  state: string;
  weekdays: number[];
  carries: CommodityId[];
}

export const FOOD_SERVICE: FoodServiceAccount[] = [
  {
    firmId: "FSM", locationId: "FS01", name: "Meridian Hospital Nutrition Services", city: "Sacramento", state: "CA",
    weekdays: [1, 2, 3, 4, 5, 6], carries: ["romaine", "tomatoes", "cucumbers", "cantaloupe", "shell_eggs", "finfish"],
  },
  {
    firmId: "FSB", locationId: "FS02", name: "Bramble Street Bistro Group (commissary)", city: "Oakland", state: "CA",
    weekdays: [1, 3, 5], carries: ["romaine", "cilantro", "tomatoes", "bell_peppers", "soft_cheese", "finfish", "sprouts"],
  },
  {
    firmId: "FSC", locationId: "FS03", name: "Campus Dining Cooperative", city: "Davis", state: "CA",
    weekdays: [1, 2, 3, 4, 5], carries: ["romaine", "tomatoes", "cucumbers", "bell_peppers", "cantaloupe", "shell_eggs", "cilantro"],
  },
];

const STREETS = [
  "Main St", "Oak Ave", "Harbor Blvd", "Mission St", "Center St", "Park Ave", "Lincoln Way",
  "Elm St", "Broadway", "Market St", "Valley Rd", "Pacific Ave", "Grand Ave", "Lake St",
];

/** Deterministic street address for the i-th location. */
export function addressFor(i: number): string {
  return `${100 + ((i * 373) % 8800)} ${STREETS[(i * 5) % STREETS.length]}`;
}
