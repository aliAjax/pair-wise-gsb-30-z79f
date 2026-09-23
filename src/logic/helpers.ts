import type {
  CompartmentLoad,
  Delivery,
  FuelReturn,
  Revision,
  RevisionChange,
  StationStop,
  Trip
} from "../types";

export function uid(prefix = "id"): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

export function now(): string {
  return new Date().toISOString();
}

export function formatNumber(value: number): string {
  return (Math.round(value * 1000) / 1000).toString();
}

export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function sortedStops(stops: StationStop[]): StationStop[] {
  return [...stops].sort((a, b) => a.order - b.order);
}

/** 各舱登记的原始装载（同舱同品合并后应唯一） */
export function tripCompartments(trip: Trip): string[] {
  return [...new Set(trip.loads.map((item) => item.compartment))].sort((a, b) => {
    const na = parseInt(a, 10);
    const nb = parseInt(b, 10);
    return Number.isNaN(na) || Number.isNaN(nb) ? a.localeCompare(b) : na - nb;
  });
}

export function originalLoad(trip: Trip, compartment: string): CompartmentLoad | undefined {
  return trip.loads.find((item) => item.compartment === compartment);
}

export function loadProduct(trip: Trip, compartment: string): string {
  return originalLoad(trip, compartment)?.product ?? "";
}

/**
 * 把修订按时间排序后回放，计算各舱"账面当前装载"。
 * 载重修订直接改账面；油品修订改舱位归属；顺序修订不影响在舱量。
 */
export interface EffectiveLoad {
  compartment: string;
  product: string;
  weight: number;
}

export function effectiveLoads(
  trip: Trip,
  revisions: Revision[] = trip.revisions
): EffectiveLoad[] {
  const map = new Map<string, EffectiveLoad>();
  for (const load of trip.loads) {
    map.set(load.compartment, {
      compartment: load.compartment,
      product: load.product,
      weight: load.weight
    });
  }
  const ordered = [...revisions].sort((a, b) => a.at.localeCompare(b.at));
  for (const revision of ordered) {
    for (const change of revision.changes) {
      if (change.field === "载重") {
        const current = map.get(change.target);
        if (current) {
          map.set(change.target, {
            ...current,
            weight: round3(current.weight + change.diff)
          });
        }
      } else if (change.field === "油品") {
        const current = map.get(change.target);
        if (current) {
          map.set(change.target, { ...current, product: change.newValue });
        }
      }
    }
  }
  return tripCompartments(trip).map((code) => map.get(code)!).filter(Boolean);
}

export function effectiveWeight(trip: Trip, compartment: string): number {
  return effectiveLoads(trip).find((item) => item.compartment === compartment)?.weight ?? 0;
}

/**
 * 到达某一站之前（不含本站交付/退油）各舱在舱量。
 * 到站顺序之前的站按顺序依次扣交付、加退油。
 */
export function onboardBeforeStop(trip: Trip, stopOrder: number): Map<string, number> {
  const balance = new Map<string, number>();
  for (const load of effectiveLoads(trip)) {
    balance.set(load.compartment, load.weight);
  }
  const stops = sortedStops(trip.stops);
  for (const stop of stops) {
    if (stop.order >= stopOrder) break;
    for (const delivery of trip.deliveries.filter((item) => item.station === stop.station)) {
      balance.set(
        delivery.compartment,
        round3((balance.get(delivery.compartment) ?? 0) - delivery.weight)
      );
    }
    for (const item of trip.returns.filter((r) => r.station === stop.station)) {
      for (const allocation of item.allocations) {
        balance.set(
          allocation.compartment,
          round3((balance.get(allocation.compartment) ?? 0) + allocation.weight)
        );
      }
    }
  }
  return balance;
}

/** 当前站某舱可卸余量 */
export function availableAtCurrentStop(trip: Trip, compartment: string): number {
  const current = sortedStops(trip.stops)[trip.currentStopIndex];
  if (!current) return 0;
  return round3(onboardBeforeStop(trip, current.order).get(compartment) ?? 0);
}

export function stopDeliveries(trip: Trip, station: string): Delivery[] {
  return trip.deliveries.filter((item) => item.station === station);
}

export function stopReturns(trip: Trip, station: string): FuelReturn[] {
  return trip.returns.filter((item) => item.station === station);
}

export function stopDeliveredWeight(trip: Trip, station: string, product?: string): number {
  return round3(
    stopDeliveries(trip, station)
      .filter((item) => !product || item.product === product)
      .reduce((sum, item) => sum + item.weight, 0)
  );
}

export function stopReturnedWeight(trip: Trip, station: string, product?: string): number {
  return round3(
    stopReturns(trip, station)
      .filter((item) => !product || item.product === product)
      .reduce((sum, item) => sum + item.allocated, 0)
  );
}

/** 本站是否已完成（有交付或退油记录即视为已办理） */
export function stopHandled(trip: Trip, station: string): boolean {
  return stopDeliveries(trip, station).length > 0 || stopReturns(trip, station).length > 0;
}

/** 汇总修订差额（核对用） */
export function revisionTotals(trip: Trip): Map<string, { product: string; diff: number }> {
  const result = new Map<string, { product: string; diff: number }>();
  for (const change of trip.revisions.flatMap((item) => item.changes)) {
    if (change.field !== "载重") continue;
    const current = result.get(change.target) ?? {
      product: change.product ?? "",
      diff: 0
    };
    current.diff = round3(current.diff + change.diff);
    result.set(change.target, current);
  }
  return result;
}

export function changeSummary(change: RevisionChange): string {
  const parts = [`${change.field}（${change.target}${change.product ? `·${change.product}` : ""}）`];
  if (change.field === "载重" || change.field === "油品") {
    parts.push(`：${change.oldValue} → ${change.newValue}`);
  } else {
    parts.push(`：${change.oldValue} → ${change.newValue}`);
  }
  return parts.join("");
}
