/**
 * 判定层：纯函数业务规则，不读写存储、不碰界面。
 *
 * 规则：
 * 1. 同舱只能装同品；
 * 2. 任一舱超量（载重）或跨品 → 整趟退回，输入由调用方保留；
 * 3. 到站顺序必须连续、站点须在路线内；
 * 4. 站方退油只能回原品空舱，超出余量转待处理，且不得压占后续站点的载量；
 * 5. 发车后舱位与顺序冻结；
 * 6. 重开后做一致性校验，冲突列出车牌、舱号、油品与差额。
 */
import type {
  Fuel,
  LoadEntry,
  Station,
  Trip,
  Vehicle
} from "../types";

export type LoadDraft = {
  compartmentNo: string;
  fuelCode: string;
  stationCode: string;
  order: number;
  tons: number;
};

export type Violation = {
  level: "error" | "warn";
  type: "compartment" | "fuel" | "station" | "order" | "freeze";
  message: string;
};

type NameResolver = {
  compartment: (no: string) => string;
  fuel: (code: string) => string;
  station: (code: string) => string;
};

export function makeResolver(vehicles: Vehicle[], fuels: Fuel[], stations: Station[], plate?: string): NameResolver {
  const fuelMap = new Map(fuels.map((f) => [f.code, f.name]));
  const stationMap = new Map(stations.map((s) => [s.code, s.name]));
  const compMap = new Map<string, string>();
  vehicles
    .filter((v) => !plate || v.plate === plate)
    .forEach((v) => v.compartments.forEach((c) => compMap.set(c.no, `${c.no}（额定${c.capacity}吨）`)));
  return {
    compartment: (no) => compMap.get(no) ?? no,
    fuel: (code) => fuelMap.get(code) ?? code,
    station: (code) => stationMap.get(code) ?? code
  };
}

function findVehicle(vehicles: Vehicle[], plate: string): Vehicle | undefined {
  return vehicles.find((v) => v.plate === plate);
}

/** 装载计划校验：跨品、超量、错序任一命中即整趟不可发车 */
export function validateLoads(
  vehicle: Vehicle,
  route: string[],
  drafts: LoadDraft[]
): Violation[] {
  const violations: Violation[] = [];
  const compMap = new Map(vehicle.compartments.map((c) => [c.no, c]));

  // 按舱聚合
  const byComp = new Map<string, LoadDraft[]>();
  drafts.forEach((d) => {
    if (!byComp.has(d.compartmentNo)) byComp.set(d.compartmentNo, []);
    byComp.get(d.compartmentNo)!.push(d);
  });

  const orders = new Set<number>();

  drafts.forEach((d) => {
    const comp = compMap.get(d.compartmentNo);
    if (!comp) {
      violations.push({ level: "error", type: "compartment", message: `${d.compartmentNo} 不属于车辆 ${vehicle.plate}` });
      return;
    }
    if (!(d.tons > 0)) {
      violations.push({ level: "error", type: "compartment", message: `${d.compartmentNo} 载重必须大于 0` });
    }
    // 舱位限装油品
    if (comp.fuelCode && comp.fuelCode !== d.fuelCode) {
      violations.push({
        level: "error",
        type: "fuel",
        message: `${d.compartmentNo} 为限定舱，只能装指定油品，当前装品不符`
      });
    }
    if (!route.includes(d.stationCode)) {
      violations.push({ level: "error", type: "station", message: `${d.compartmentNo} 的到站不在登记路线内` });
    }
    if (d.order < 1 || d.order > Math.max(1, route.length)) {
      violations.push({ level: "error", type: "order", message: `${d.compartmentNo} 到站顺序 ${d.order} 超出路线范围` });
    }
    orders.add(d.order);
  });

  // 同舱跨品
  byComp.forEach((list, no) => {
    const fuelsInComp = new Set(list.map((d) => d.fuelCode));
    if (fuelsInComp.size > 1) {
      violations.push({ level: "error", type: "fuel", message: `${no} 同舱装入多种油品（跨品），整趟退回` });
    }
    // 同舱总量超额定载重
    const comp = compMap.get(no);
    const total = list.reduce((acc, d) => acc + d.tons, 0);
    if (comp && total > comp.capacity + 1e-9) {
      violations.push({
        level: "error",
        type: "compartment",
        message: `${no} 合装 ${round2(total)} 吨，超出额定载重 ${comp.capacity} 吨 ${round2(total - comp.capacity)} 吨`
      });
    }
  });

  // 顺序连续校验：路线有 N 站时，1..N 中每个顺序至少有一个舱计划，且不得空跳
  const n = route.length;
  if (n > 0) {
    for (let i = 1; i <= n; i += 1) {
      if (!orders.has(i)) {
        violations.push({ level: "error", type: "order", message: `到站顺序缺少第 ${i} 站的装载计划` });
      }
    }
  }

  return violations;
}

export function round2(n: number) {
  return Math.round(n * 100) / 100;
}

/** 装载行累计已卸量（含沿修订链继承的前序版本已卸量） */
export function deliveredOf(l: LoadEntry): number {
  return round2(l.deliveredTons + (l.carriedDeliveredTons ?? 0));
}

/**
 * 计算某舱在某站卸完后、可供退油回装的空舱余量。
 * 余量 = 该舱中"本站及本站之前"应卸的同品载量 - 已占用（已登记退油回装）。
 * 只允许原品：舱内现存油品必须与退油油品一致。
 * 不允许压占后续站点：分配给后续站的载量不计入余量。
 */
export function compartmentReturnCapacity(
  trip: Trip,
  stationOrder: number,
  compartmentNo: string,
  fuelCode: string
): { ok: boolean; capacity: number; reason?: string } {
  const compLoads = trip.loads.filter((l) => !l.void && l.compartmentNo === compartmentNo);
  if (compLoads.length === 0) {
    return { ok: false, capacity: 0, reason: "该舱无装载计划" };
  }
  // 原品校验：同舱只能装同品
  const compFuel = compLoads[0].fuelCode;
  if (compLoads.some((l) => l.fuelCode !== compFuel)) {
    return { ok: false, capacity: 0, reason: "该舱存在跨品记录，不可退油回装" };
  }
  if (compFuel !== fuelCode) {
    return { ok: false, capacity: 0, reason: `只能回原品空舱：舱内为 ${compFuel}，退油品为 ${fuelCode}` };
  }

  // 本站顺序计划在此舱卸出、且已经实际卸空形成的空舱：可用于本站退油回装。
  // 后续站点的载量（l.order > stationOrder）绝不能计入，避免压占后续站点。
  const atStation = compLoads.filter((l) => l.order === stationOrder);
  if (atStation.length === 0) {
    return { ok: false, capacity: 0, reason: "该舱在本站无卸油计划（属后续站点舱容），不得压占" };
  }
  const emptiedAtStation = atStation.reduce((acc, l) => acc + deliveredOf(l), 0);

  // 已被同站/前序退油占用的回装量（本站及之前顺序的回装记录）
  const occupied = trip.returns
    .filter((r) => r.order <= stationOrder)
    .flatMap((r) => r.allocated)
    .filter((a) => a.compartmentNo === compartmentNo)
    .reduce((acc, a) => acc + a.tons, 0);

  const capacity = round2(Math.max(0, emptiedAtStation - occupied));
  if (emptiedAtStation <= 0) {
    return { ok: false, capacity: 0, reason: "该舱在本站尚未卸出同品载量，不能占用后续站点舱容" };
  }
  return { ok: true, capacity };
}

export type ReturnPlanResult = {
  allocated: { compartmentNo: string; tons: number }[];
  overflowTons: number;
  warnings: string[];
};

/**
 * 规划退油回装：在用户指定的候选原品空舱中按余量依次装入；
 * 装不下的部分转待处理（overflow），绝不压占后续站点。
 */
export function planReturn(
  trip: Trip,
  stationOrder: number,
  fuelCode: string,
  tons: number,
  candidateCompartments: string[]
): ReturnPlanResult {
  const warnings: string[] = [];
  const allocated: { compartmentNo: string; tons: number }[] = [];
  let remaining = round2(tons);
  // 本次规划中各舱已占用量（不动 trip 数据）
  const reserved = new Map<string, number>();

  candidateCompartments.forEach((no) => {
    if (remaining <= 1e-9) return;
    const cap = compartmentReturnCapacity(trip, stationOrder, no, fuelCode);
    if (!cap.ok || cap.capacity <= 1e-9) {
      if (cap.reason) warnings.push(`${no}：${cap.reason}`);
      return;
    }
    const free = round2(cap.capacity - (reserved.get(no) ?? 0));
    const put = round2(Math.min(remaining, Math.max(0, free)));
    if (put > 0) {
      allocated.push({ compartmentNo: no, tons: put });
      reserved.set(no, (reserved.get(no) ?? 0) + put);
      remaining = round2(remaining - put);
    }
  });

  return { allocated, overflowTons: round2(Math.max(0, remaining)), warnings };
}

export type ReopenConflict = {
  plate: string;
  compartmentNo: string;
  fuelCode: string;
  fuelName: string;
  diffTons: number; // 正：多发/多装差额；负：少卸/缺口
  detail: string;
};

/**
 * 重开一致性校验：配送、舱位、退油、修订须相互对应。
 *
 * 仅对"发生过修订（存在 void 旧行）的 舱×油品 组"做物理平衡：
 *   舱内应有现存 = 原载总量 − 已卸 + 退油回装（回装进舱）− 修订挂账（移出待处理）
 *   重开后新计划占用 = 有效（非 void）装载量
 *   差额 = 应有现存 − 新计划占用；多油/少油都必须查清。
 * 未修订的组不参与此平衡（正常卸油+退油由退油闭环校验3对账）。
 * 冲突列车牌、舱号、油品与差额。
 */
export function findReopenConflicts(
  trip: Trip,
  vehicles: Vehicle[],
  fuels: Fuel[]
): ReopenConflict[] {
  const conflicts: ReopenConflict[] = [];
  const vehicle = findVehicle(vehicles, trip.plate);
  const fuelName = (code: string) => fuels.find((f) => f.code === code)?.name ?? code;
  const capacityOf = (no: string) => vehicle?.compartments.find((c) => c.no === no)?.capacity;

  // 1. 修订组的舱 × 油品物理平衡（沿修订链计算，计划快照不累加）
  const groups = new Map<string, LoadEntry[]>();
  trip.loads.forEach((l) => {
    const key = `${l.compartmentNo}|${l.fuelCode}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(l);
  });

  const byId = new Map(trip.loads.map((l) => [l.id, l]));
  /** 组内实际装过的物理油量：只计修订链根节点；由别的舱/品修订转入的行无物理来源 */
  const physicalLoadedOfGroup = (list: LoadEntry[]): number =>
    round2(
      list.reduce((acc, l) => {
        if (!l.supersedes) return acc + l.tons; // 最初装车版本
        const prev = byId.get(l.supersedes);
        if (prev && prev.compartmentNo === l.compartmentNo && prev.fuelCode === l.fuelCode) {
          return acc; // 同舱同品的后继版本，物理油沿链而来，不重复计
        }
        return acc; // 跨舱/跨品转入：本舱本品没有这批物理油
      }, 0)
    );

  groups.forEach((list, key) => {
    const [no, fuelCode] = key.split("|");
    const activeList = list.filter((l) => !l.void);
    const newPlanned = round2(activeList.reduce((a, l) => a + l.tons, 0));

    // 2. 新计划超舱容（无论是否修订都要查）
    const cap = capacityOf(no);
    if (cap !== undefined && newPlanned > cap + 1e-9) {
      conflicts.push({
        plate: trip.plate,
        compartmentNo: no,
        fuelCode,
        fuelName: fuelName(fuelCode),
        diffTons: round2(newPlanned - cap),
        detail: `重开后 ${no} 同品合装 ${newPlanned} 吨，超额定 ${cap} 吨，差额 ${round2(newPlanned - cap)} 吨`
      });
    }

    const hasRevision = list.some((l) => l.void) || list.some((l) => l.supersedes);
    if (!hasRevision) return;

    const physicalLoaded = physicalLoadedOfGroup(list);
    // 已卸沿修订链累计；组内全部作废时计最后版本的已卸
    const effectiveList = activeList.length ? activeList : list;
    const delivered = round2(effectiveList.reduce((a, l) => a + deliveredOf(l), 0));
    const returned = sumReturned(trip, no, fuelCode);
    // 移出本舱本品的挂账（已结清也代表油已不在舱）
    const revisionPending = round2(
      trip.pending
        .filter((p) => p.kind === "revision" && p.compartmentNo === no && p.fuelCode === fuelCode)
        .reduce((a, p) => a + p.tons, 0)
    );
    const onHand = round2(physicalLoaded - delivered + returned - revisionPending);
    const diff = round2(onHand - newPlanned);

    if (Math.abs(diff) > 1e-9) {
      const direction = diff > 0
        ? `多 ${diff} 吨在舱但新计划未安排（也未挂待处理）`
        : `新计划多排 ${Math.abs(diff)} 吨无舱内来源`;
      conflicts.push({
        plate: trip.plate,
        compartmentNo: no,
        fuelCode,
        fuelName: fuelName(fuelCode),
        diffTons: diff,
        detail:
          `实装 ${physicalLoaded} − 已卸 ${delivered} + 回装 ${returned} − 挂账 ${revisionPending}` +
          ` = 舱存 ${onHand}，重开后新计划 ${newPlanned}，${direction}`
      });
    }
  });

  // 3. 退油闭环：回装量 + 未结清溢出挂账必须等于申报量
  trip.returns.forEach((r) => {
    const allocated = round2(r.allocated.reduce((acc, a) => acc + a.tons, 0));
    const overflowPending = round2(
      trip.pending
        .filter((p) => !p.resolved && p.kind === "overflow" && p.fuelCode === r.fuelCode && p.stationCode === r.stationCode)
        .reduce((acc, p) => acc + p.tons, 0)
    );
    const diff = round2(r.tons - allocated - overflowPending);
    if (Math.abs(diff) > 1e-9) {
      conflicts.push({
        plate: trip.plate,
        compartmentNo: r.allocated[0]?.compartmentNo ?? "—",
        fuelCode: r.fuelCode,
        fuelName: fuelName(r.fuelCode),
        diffTons: diff,
        detail: `第${r.order}站退油申报 ${r.tons} 吨，回装 ${allocated} 吨、溢出待处理 ${overflowPending} 吨，差额 ${diff} 吨`
      });
    }
  });

  return conflicts;
}

/** 某舱某品在本趟全部退油记录中的回装量 */
function sumReturned(trip: Trip, compartmentNo: string, fuelCode: string): number {
  return round2(
    trip.returns
      .filter((r) => r.fuelCode === fuelCode)
      .flatMap((r) => r.allocated)
      .filter((a) => a.compartmentNo === compartmentNo)
      .reduce((acc, a) => acc + a.tons, 0)
  );
}

/** 发车冻结后，任何舱位/顺序修改必须走重开+修订 */
export function isFrozen(trip: Trip): boolean {
  return trip.status === "运输中" || trip.status === "已到站";
}

export function describeLoad(d: LoadDraft | LoadEntry, r: NameResolver): string {
  return `${r.compartment(d.compartmentNo)} / ${r.fuel(d.fuelCode)} / ${round2(d.tons)}吨 / 第${d.order}站 ${r.station(d.stationCode)}`;
}
