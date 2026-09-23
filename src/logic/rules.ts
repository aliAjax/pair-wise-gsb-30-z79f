import { getCompartmentCapacity } from "../data/catalog";
import type {
  Delivery,
  LoadDraft,
  PendingItem,
  ReturnAllocation,
  StationStop,
  Trip,
  TripConflict,
  ValidationIssue
} from "../types";
import {
  effectiveLoads,
  loadProduct,
  onboardBeforeStop,
  round3,
  sortedStops,
  stopDeliveredWeight,
  tripCompartments
} from "./helpers";

/**
 * 判定层：全部业务规则集中在这里，页面/存储不自行解释规则。
 * 规则：
 * R1 同舱只能装同品；任一舱超核定载重或跨品 → 整趟退回（不保存），输入由页面保留
 * R2 站方退油只能回原品且当前可用的舱；入不下的数量转待处理，不得压占后续站点余量
 * R3 发车后舱位（油品）与到站顺序冻结；载重调整必须留原因和旧值，油品/顺序调整须先重开
 * R4 重开后配送、舱位、退油、修订仍相互对应；核对按车牌、舱号、油品列出差额冲突
 */

export function validateLoads(
  plate: string,
  drafts: LoadDraft[],
  knownCompartments: string[]
): { loads: LoadDraft[]; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const merged = new Map<string, LoadDraft>();

  for (const draft of drafts) {
    if (!draft.compartment) {
      issues.push({ message: "存在未选择舱号的装载行" });
      continue;
    }
    if (!draft.product) {
      issues.push({ message: `${draft.compartment} 未选择油品` , compartment: draft.compartment });
      continue;
    }
    if (!Number.isFinite(draft.weight) || draft.weight <= 0) {
      issues.push({
        message: `${draft.compartment} 载重必须为正数`,
        compartment: draft.compartment,
        product: draft.product
      });
      continue;
    }
    const existing = merged.get(draft.compartment);
    if (existing && existing.product !== draft.product) {
      // R1：跨品
      issues.push({
        message: `${draft.compartment} 跨品混装：${existing.product} 与 ${draft.product}`,
        compartment: draft.compartment
      });
      continue;
    }
    if (existing) {
      existing.weight = round3(existing.weight + draft.weight);
    } else {
      merged.set(draft.compartment, { ...draft, weight: draft.weight });
    }
  }

  const loads = [...merged.values()];

  for (const load of loads) {
    const capacity = getCompartmentCapacity(plate, load.compartment);
    if (capacity <= 0) {
      issues.push({
        message: `${load.compartment} 不属于车辆 ${plate}`,
        compartment: load.compartment
      });
    } else if (load.weight > capacity + 1e-9) {
      // R1：超量
      issues.push({
        message: `${load.compartment}（${load.product}）装载 ${load.weight} 吨，超过核定载重 ${capacity} 吨`,
        compartment: load.compartment,
        product: load.product
      });
    }
  }

  const unknown = loads.filter((load) => !knownCompartments.includes(load.compartment));
  for (const load of unknown) {
    if (!issues.some((issue) => issue.compartment === load.compartment && issue.message.includes("不属于"))) {
      issues.push({ message: `${load.compartment} 不在该车舱位表内`, compartment: load.compartment });
    }
  }

  return { loads, issues };
}

export function validateStops(stops: StationStop[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (stops.length === 0) {
    issues.push({ message: "至少登记一个到站" });
    return issues;
  }
  const orders = stops.map((item) => item.order);
  if (new Set(orders).size !== orders.length) {
    issues.push({ message: "到站顺序不能重复" });
  }
  if (orders.some((order) => order < 1)) {
    issues.push({ message: "到站顺序必须从 1 开始" });
  }
  const stationNames = stops.map((item) => item.station);
  if (new Set(stationNames).size !== stationNames.length) {
    issues.push({ message: "同一站在一趟中不能重复登记" });
  }
  for (const stop of stops) {
    for (const [product, tons] of Object.entries(stop.demands)) {
      if (!Number.isFinite(tons) || tons < 0) {
        issues.push({
          message: `第${stop.order}站 ${stop.station} 的 ${product} 需求数量无效`,
          station: stop.station,
          product
        });
      }
    }
  }
  return issues;
}

/** 发车前提示级校验：某站某品需求是否超过到达该站时的在途余量（不阻断，仅提示） */
export function demandShortages(
  plate: string,
  loads: { compartment: string; product: string; weight: number }[],
  stops: StationStop[]
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const balance = new Map<string, number>();
  for (const load of loads) {
    balance.set(load.compartment, load.weight);
  }
  for (const stop of sortedStops(stops)) {
    for (const [product, demand] of Object.entries(stop.demands)) {
      if (!demand) continue;
      const available = round3(
        loads
          .filter((load) => load.compartment !== "" && load.product === product)
          .reduce((sum, load) => sum + (balance.get(load.compartment) ?? 0), 0)
      );
      if (demand > available + 1e-9) {
        issues.push({
          message: `第${stop.order}站 ${stop.station} 的 ${product} 需求 ${demand} 吨，超过到达时在舱余量 ${available} 吨`,
          station: stop.station,
          product
        });
      }
    }
    // 按需求模拟扣除，供后续站判断
    for (const [product, demand] of Object.entries(stop.demands)) {
      let remain = demand;
      for (const [compartment, weight] of [...balance.entries()]) {
        if (remain <= 0) break;
        const load = loads.find((item) => item.compartment === compartment);
        if (!load || load.product !== product) continue;
        const take = Math.min(weight, remain);
        balance.set(compartment, round3(weight - take));
        remain = round3(remain - take);
      }
    }
  }
  // plate 仅用于未来按车辆扩展规则，目前容量校验已在 validateLoads 完成
  void plate;
  return issues;
}

/**
 * R2：退油只回原品舱。入舱基数 = 到站前在舱量 − 本站已交付 + 本站已入舱退油，
 * 即本站卸空腾出的舱位也可接收；空舱优先，其次同品余量舱，入到核定载重为止。
 * 超出余量转待处理，绝不压占后续站点（不向其他品舱、其他舱位借容）。
 */
export function allocateReturn(
  trip: Trip,
  product: string,
  weight: number
): { allocations: ReturnAllocation[]; overflow: number; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const current = sortedStops(trip.stops)[trip.currentStopIndex];
  if (!current) {
    issues.push({ message: "当前没有可办理退油的站点" });
    return { allocations: [], overflow: weight, issues };
  }
  if (!Number.isFinite(weight) || weight <= 0) {
    issues.push({ message: "退油数量必须为正数", product });
    return { allocations: [], overflow: 0, issues };
  }
  const balance = onboardBeforeStop(trip, current.order);
  for (const delivery of trip.deliveries.filter((item) => item.station === current.station)) {
    balance.set(
      delivery.compartment,
      round3((balance.get(delivery.compartment) ?? 0) - delivery.weight)
    );
  }
  for (const item of trip.returns.filter((r) => r.station === current.station)) {
    for (const allocation of item.allocations) {
      balance.set(
        allocation.compartment,
        round3((balance.get(allocation.compartment) ?? 0) + allocation.weight)
      );
    }
  }

  const allocations: ReturnAllocation[] = [];
  let remain = round3(weight);

  // 空舱优先，再按舱号顺序使用同品余量舱
  const candidates = tripCompartments(trip)
    .filter((compartment) => loadProduct(trip, compartment) === product)
    .sort((a, b) => {
      const diff = (balance.get(a) ?? 0) - (balance.get(b) ?? 0);
      if (Math.abs(diff) > 1e-9) return diff;
      return parseInt(a, 10) - parseInt(b, 10);
    });

  for (const compartment of candidates) {
    if (remain <= 1e-9) break;
    const onBoardWeight = round3(balance.get(compartment) ?? 0);
    if (onBoardWeight < -1e-9) {
      issues.push({
        message: `${compartment} 在舱量异常，暂停入舱`,
        compartment,
        product
      });
      continue;
    }
    const spare = round3(getCompartmentCapacity(trip.plate, compartment) - onBoardWeight);
    if (spare <= 1e-9) continue;
    const take = round3(Math.min(spare, remain));
    if (take > 0) {
      allocations.push({ compartment, product, weight: take });
      balance.set(compartment, round3(onBoardWeight + take));
      remain = round3(remain - take);
    }
  }

  const overflow = round3(Math.max(0, remain));
  if (overflow > 0) {
    issues.push({
      message: `${product} 有 ${overflow} 吨原品空舱余量不足，转待处理，不压占后续站点`,
      station: current.station,
      product
    });
  }
  return { allocations, overflow, issues };
}

/** 交付校验：某舱卸油不能超过到站时在舱余量，且舱品必须一致 */
export function validateDelivery(
  trip: Trip,
  delivery: Omit<Delivery, "id" | "at">
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const current = sortedStops(trip.stops)[trip.currentStopIndex];
  if (!current) {
    issues.push({ message: "当前没有可办理交付的站点" });
    return issues;
  }
  if (delivery.station !== current.station) {
    issues.push({ message: "只能在当前停靠站办理交付", station: delivery.station });
  }
  const product = loadProduct(trip, delivery.compartment);
  if (!product) {
    issues.push({ message: `${delivery.compartment} 未装载油品`, compartment: delivery.compartment });
  } else if (product !== delivery.product) {
    issues.push({
      message: `${delivery.compartment} 装载的是 ${product}，不能交付 ${delivery.product}`,
      compartment: delivery.compartment,
      product: delivery.product
    });
  }
  if (!Number.isFinite(delivery.weight) || delivery.weight <= 0) {
    issues.push({ message: "交付数量必须为正数", compartment: delivery.compartment });
    return issues;
  }
  const onboard = onboardBeforeStop(trip, current.order);
  const already = round3(
    trip.deliveries
      .filter((item) => item.station === current.station && item.compartment === delivery.compartment)
      .reduce((sum, item) => sum + item.weight, 0)
  );
  const available = round3((onboard.get(delivery.compartment) ?? 0) - already);
  if (delivery.weight > available + 1e-9) {
    issues.push({
      message: `${delivery.compartment} 本站可卸余量仅 ${available} 吨`,
      compartment: delivery.compartment,
      product
    });
  }
  return issues;
}

/** 发车前载重/油品/顺序编辑（未冻结或重开后）的舱位合法性 */
export function validateLoadEdit(
  trip: Trip,
  compartment: string,
  patch: { product?: string; weight?: number }
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (patch.weight !== undefined) {
    if (!Number.isFinite(patch.weight) || patch.weight < 0) {
      issues.push({ message: `${compartment} 载重必须是非负数`, compartment });
    } else {
      const capacity = getCompartmentCapacity(trip.plate, compartment);
      if (patch.weight > capacity + 1e-9) {
        issues.push({
          message: `${compartment} 调整后 ${patch.weight} 吨超过核定载重 ${capacity} 吨`,
          compartment
        });
      }
    }
  }
  if (trip.frozen && !trip.adjustUnlocked && patch.product !== undefined) {
    issues.push({ message: "舱位油品已冻结，需先重开行程并填写原因" });
  }
  return issues;
}

/** R4：整趟核对。按 车牌 → 舱号 → 油品 列出应有/实际与差额冲突 */
export function reconcile(trip: Trip, pendings: PendingItem[]): TripConflict[] {
  const conflicts: TripConflict[] = [];
  const effective = new Map(effectiveLoads(trip).map((item) => [item.compartment, item]));

  for (const compartment of tripCompartments(trip)) {
    const load = effective.get(compartment)!;
    const product = load.product;

    // 实际在舱量：账面装载 - 全部交付 + 全部已入舱退油
    const delivered = round3(
      trip.deliveries
        .filter((item) => item.compartment === compartment)
        .reduce((sum, item) => sum + item.weight, 0)
    );
    const returned = round3(
      trip.returns
        .flatMap((item) => item.allocations)
        .filter((item) => item.compartment === compartment)
        .reduce((sum, item) => sum + item.weight, 0)
    );
    const actual = round3(load.weight - delivered + returned);

    // 超核定载重
    const capacity = getCompartmentCapacity(trip.plate, compartment);
    if (actual > capacity + 1e-9) {
      conflicts.push({
        scope: "舱号",
        target: compartment,
        product,
        expected: capacity,
        actual,
        diff: round3(actual - capacity)
      });
    }

    // 负库存
    if (actual < -1e-9) {
      conflicts.push({
        scope: "舱号",
        target: compartment,
        product,
        expected: 0,
        actual,
        diff: actual
      });
    }

    // 修订后账面与实际作业对不上（修订了载重，但既没相应交付也没退油）
    const reviseDiff = round3(
      trip.revisions
        .flatMap((item) => item.changes)
        .filter((item) => item.field === "载重" && item.target === compartment)
        .reduce((sum, item) => sum + item.diff, 0)
    );
    if (Math.abs(reviseDiff) > 1e-9) {
      // 账面相对原始装载变化 reviseDiff；实际作业变化为 -(交付) +(退油)
      const operationChange = round3(-delivered + returned);
      const unexplained = round3(reviseDiff - operationChange);
      if (Math.abs(unexplained) > 1e-9 && actual >= -1e-9 && actual <= capacity + 1e-9) {
        conflicts.push({
          scope: "油品",
          target: compartment,
          product,
          expected: round3(load.weight - reviseDiff + operationChange),
          actual: load.weight,
          diff: unexplained
        });
      }
    }
  }

  // 途中压占：任一站交付前在舱量为负
  const stops = sortedStops(trip.stops);
  for (const stop of stops) {
    const before = onboardBeforeStop(trip, stop.order);
    for (const [compartment, weight] of before) {
      if (weight < -1e-9) {
        const product = loadProduct(trip, compartment);
        conflicts.push({
          scope: "舱号",
          target: `${compartment}@${stop.station}`,
          product,
          expected: 0,
          actual: weight,
          diff: weight
        });
      }
    }
  }

  // 油品一致性：同舱登记油品与交付/退油油品不一致（历史上靠规则拦截，核对兜底）
  for (const delivery of trip.deliveries) {
    const product = loadProduct(trip, delivery.compartment);
    if (product && product !== delivery.product) {
      conflicts.push({
        scope: "油品",
        target: delivery.compartment,
        product: delivery.product,
        expected: 0,
        actual: delivery.weight,
        diff: delivery.weight
      });
    }
  }
  for (const item of trip.returns) {
    for (const allocation of item.allocations) {
      const product = loadProduct(trip, allocation.compartment);
      if (product && product !== allocation.product) {
        conflicts.push({
          scope: "油品",
          target: allocation.compartment,
          product: allocation.product,
          expected: 0,
          actual: allocation.weight,
          diff: allocation.weight
        });
      }
    }
  }

  // 待处理退油：未处理项按车牌挂账
  for (const pending of pendings.filter(
    (item) => item.tripId === trip.id && !item.handled && item.weight > 1e-9
  )) {
    conflicts.push({
      scope: "车牌",
      target: trip.plate,
      product: pending.product,
      expected: 0,
      actual: pending.weight,
      diff: pending.weight
    });
  }

  // 欠交：已到站且某品交付少于总需求（退油是站方余量，不抵扣需求）
  if (trip.status === "已到站") {
    for (const stop of trip.stops) {
      for (const [product, demand] of Object.entries(stop.demands)) {
        const delivered = stopDeliveredWeight(trip, stop.station, product);
        const shortage = round3(demand - delivered);
        if (shortage > 1e-9) {
          conflicts.push({
            scope: "车牌",
            target: `${trip.plate}·${stop.station}`,
            product,
            expected: demand,
            actual: delivered,
            diff: round3(-shortage)
          });
        }
      }
    }
  }

  return dedupeConflicts(conflicts);
}

function dedupeConflicts(conflicts: TripConflict[]): TripConflict[] {
  const seen = new Map<string, TripConflict>();
  for (const conflict of conflicts) {
    const key = `${conflict.scope}|${conflict.target}|${conflict.product}|${conflict.diff}`;
    if (!seen.has(key)) seen.set(key, conflict);
  }
  return [...seen.values()];
}
