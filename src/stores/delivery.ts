/**
 * 存储层：Pinia 状态 + localStorage 持久化。
 * 只做"取数 / 存数 / 调用判定层编排动作"，不写界面。
 */
import { computed, ref } from "vue";
import { defineStore } from "pinia";
import type {
  Database,
  LoadEntry,
  PendingItem,
  ReturnRecord,
  Revision,
  Trip
} from "../types";
import { buildSeedDatabase, nowIso } from "../data/catalog";
import {
  deliveredOf,
  findReopenConflicts,
  isFrozen,
  planReturn,
  round2,
  validateLoads,
  type LoadDraft,
  type ReopenConflict,
  type Violation
} from "../domain/rules";

const STORAGE_KEY = "hxwlfront-19-oil-delivery-v2";

function uid(prefix: string) {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function loadDatabase(): Database {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Database;
      if (parsed && Array.isArray(parsed.trips)) return parsed;
    } catch {
      // 数据损坏时回退种子数据
    }
  }
  return buildSeedDatabase();
}

export type ActionResult = {
  ok: boolean;
  violations?: Violation[];
  conflicts?: ReopenConflict[];
  message?: string;
};

export const useDeliveryStore = defineStore("delivery", () => {
  const db = ref<Database>(loadDatabase());

  const vehicles = computed(() => db.value.vehicles);
  const stations = computed(() => db.value.stations);
  const fuels = computed(() => db.value.fuels);
  const trips = computed(() => db.value.trips);

  const fuelName = (code: string) => fuels.value.find((f) => f.code === code)?.name ?? code;
  const stationName = (code: string) => stations.value.find((s) => s.code === code)?.name ?? code;
  const getVehicle = (plate: string) => vehicles.value.find((v) => v.plate === plate);

  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db.value));
  }

  function getTrip(id: string) {
    return db.value.trips.find((t) => t.id === id);
  }

  /** 新建趟次：跨品/超量/错序则整趟退回（页面保留输入） */
  function createTrip(plate: string, route: string[], drafts: LoadDraft[], notes: string): ActionResult {
    const vehicle = getVehicle(plate);
    if (!vehicle) return { ok: false, violations: [], message: "请选择车辆" };
    if (route.length === 0) return { ok: false, violations: [], message: "请登记到站顺序（至少一站）" };
    if (new Set(route).size !== route.length) {
      return { ok: false, violations: [], message: "到站顺序中存在重复站点" };
    }
    const violations = validateLoads(vehicle, route, drafts);
    if (violations.some((v) => v.level === "error")) {
      return { ok: false, violations, message: "整趟退回：存在超量、跨品或顺序错误，输入已保留" };
    }
    const trip: Trip = {
      id: uid("trip"),
      plate,
      route: [...route],
      loads: drafts.map((d) => ({ ...d, id: uid("load"), deliveredTons: 0 })),
      returns: [],
      revisions: [],
      pending: [],
      status: "待发车",
      notes: notes || "暂无备注",
      createdAt: nowIso()
    };
    db.value.trips.unshift(trip);
    persist();
    return { ok: true, message: "趟次已保存，待发车" };
  }

  /** 发车：舱位与到站顺序自此冻结 */
  function depart(id: string): ActionResult {
    const trip = getTrip(id);
    if (!trip) return { ok: false, message: "趟次不存在" };
    if (trip.status !== "待发车" && trip.status !== "重开") {
      return { ok: false, message: "仅待发车 / 重开状态可以发车" };
    }
    if (trip.status === "重开") {
      const conflicts = findReopenConflicts(trip, db.value.vehicles, db.value.fuels);
      if (conflicts.length > 0) {
        return { ok: false, conflicts, message: "重开后数据仍不对应，存在未结清差额，暂不能发车" };
      }
      const unresolved = trip.pending.filter((p) => !p.resolved);
      if (unresolved.length > 0) {
        return {
          ok: false,
          message: `尚有 ${unresolved.length} 项待处理（共 ${round2(unresolved.reduce((a, p) => a + p.tons, 0))} 吨）未登记结清，暂不能发车`
        };
      }
    }
    trip.status = "运输中";
    trip.departAt = nowIso();
    persist();
    return { ok: true, message: "已发车，舱位与到站顺序冻结" };
  }

  /** 到站登记卸油（按舱登记实收吨数，不得超过计划剩余） */
  function registerDelivery(tripId: string, deliveries: { loadId: string; tons: number }[]): ActionResult {
    const trip = getTrip(tripId);
    if (!trip) return { ok: false, message: "趟次不存在" };
    if (trip.status !== "运输中") return { ok: false, message: "仅运输中的趟次可登记到站" };

    for (const d of deliveries) {
      const load = trip.loads.find((l) => l.id === d.loadId && !l.void);
      if (!load) return { ok: false, message: "舱位计划不存在或已废弃" };
      const remaining = round2(load.tons - deliveredOf(load));
      if (d.tons < -1e-9 || d.tons > remaining + 1e-9) {
        return {
          ok: false,
          message: `${load.compartmentNo} 本次卸油 ${d.tons} 吨超出可卸余量 ${remaining} 吨`
        };
      }
    }
    deliveries.forEach((d) => {
      const load = trip.loads.find((l) => l.id === d.loadId && !l.void);
      if (load) load.deliveredTons = round2(load.deliveredTons + d.tons);
    });
    persist();
    return { ok: true, message: "到站卸油已登记" };
  }

  /** 站方退油：只回原品空舱，超出余量转待处理，不压占后续站点 */
  function registerReturn(
    tripId: string,
    stationCode: string,
    fuelCode: string,
    tons: number,
    candidateCompartments: string[]
  ): ActionResult & { recordId?: string } {
    const trip = getTrip(tripId);
    if (!trip) return { ok: false, message: "趟次不存在" };
    if (trip.status !== "运输中" && trip.status !== "重开") {
      return { ok: false, message: "仅运输中 / 重开状态可登记退油" };
    }
    const order = trip.route.indexOf(stationCode) + 1;
    if (!order) return { ok: false, message: "该站不在本趟到站顺序内" };
    if (!(tons > 0)) return { ok: false, message: "退油量必须大于 0" };

    const plan = planReturn(trip, order, fuelCode, tons, candidateCompartments);
    const record: ReturnRecord = {
      id: uid("ret"),
      tripId,
      stationCode,
      order,
      fuelCode,
      tons: round2(tons),
      allocated: plan.allocated,
      overflowTons: plan.overflowTons,
      createdAt: nowIso()
    };
    trip.returns.push(record);

    if (plan.overflowTons > 1e-9) {
      const item: PendingItem = {
        id: uid("pend"),
        tripId,
        plate: trip.plate,
        stationCode,
        fuelCode,
        tons: plan.overflowTons,
        kind: "overflow",
        reason: `退油 ${round2(tons)} 吨，原品空舱余量仅 ${round2(tons - plan.overflowTons)} 吨，超出 ${plan.overflowTons} 吨转待处理（不压占后续站点）`,
        createdAt: nowIso(),
        resolved: false
      };
      trip.pending.push(item);
    }
    persist();
    const extra = plan.warnings.length ? `；${plan.warnings.join("；")}` : "";
    return {
      ok: true,
      recordId: record.id,
      message:
        plan.overflowTons > 0
          ? `回装 ${round2(tons - plan.overflowTons)} 吨，${plan.overflowTons} 吨转待处理${extra}`
          : `退油已全部回装原品空舱${extra}`
    };
  }

  /** 完成送达 */
  function complete(id: string): ActionResult {
    const trip = getTrip(id);
    if (!trip || trip.status !== "运输中") return { ok: false, message: "仅运输中的趟次可完成" };
    const undelivered = trip.loads
      .filter((l) => !l.void)
      .reduce((acc, l) => acc + round2(l.tons - deliveredOf(l)), 0);
    if (undelivered > 1e-9) {
      return { ok: false, message: `尚有 ${round2(undelivered)} 吨未登记卸油，不能完结` };
    }
    trip.status = "已到站";
    trip.completeAt = nowIso();
    persist();
    return { ok: true, message: "本趟已全部到站完成" };
  }

  /** 重开：冻结解除的唯一入口，所有调整必须留原因与旧值 */
  function reopen(id: string, reason: string): ActionResult {
    const trip = getTrip(id);
    if (!trip) return { ok: false, message: "趟次不存在" };
    if (!isFrozen(trip)) return { ok: false, message: "仅发车后的趟次可以重开" };
    if (!reason.trim()) return { ok: false, message: "重开必须填写原因" };
    trip.status = "重开";
    trip.reopenAt = nowIso();
    trip.revisions.push({
      id: uid("rv"),
      tripId: id,
      field: "状态",
      label: trip.plate,
      oldValue: "运输中 / 已到站（冻结）",
      newValue: "重开（可调整）",
      reason: reason.trim(),
      createdAt: nowIso()
    });
    persist();
    return { ok: true, message: "趟次已重开，调整将逐条保留修订记录" };
  }

  function addRevision(trip: Trip, field: string, label: string, oldValue: string, newValue: string, reason: string) {
    const revision: Revision = {
      id: uid("rv"),
      tripId: trip.id,
      field,
      label,
      oldValue,
      newValue,
      reason: reason.trim(),
      createdAt: nowIso()
    };
    trip.revisions.push(revision);
  }

  /** 重开后调整某舱计划：旧行作废保留（void），新建新行，记修订 */
  function reviseLoad(tripId: string, loadId: string, patch: Partial<LoadDraft>, reason: string): ActionResult {
    const trip = getTrip(tripId);
    if (!trip) return { ok: false, message: "趟次不存在" };
    if (trip.status !== "重开") return { ok: false, message: "冻结中：请先重开本趟再调整" };
    const old = trip.loads.find((l) => l.id === loadId && !l.void);
    if (!old) return { ok: false, message: "原装载行不存在" };
    if (!reason.trim()) return { ok: false, message: "调整必须填写原因" };

    const next: LoadDraft = {
      compartmentNo: patch.compartmentNo ?? old.compartmentNo,
      fuelCode: patch.fuelCode ?? old.fuelCode,
      stationCode: patch.stationCode ?? old.stationCode,
      order: patch.order ?? old.order,
      tons: patch.tons ?? old.tons
    };

    // 用"旧行作废 + 新行"试组一遍再校验
    const trialDrafts: LoadDraft[] = [
      ...trip.loads.filter((l) => l.id !== loadId && !l.void).map((l) => ({
        compartmentNo: l.compartmentNo,
        fuelCode: l.fuelCode,
        stationCode: l.stationCode,
        order: l.order,
        tons: l.tons
      })),
      next
    ];
    const vehicle = getVehicle(trip.plate)!;
    const violations = validateLoads(vehicle, trip.route, trialDrafts);
    if (violations.some((v) => v.level === "error")) {
      return { ok: false, violations, message: "调整后整趟校验未通过，已保留原值与输入" };
    }

    const oldDesc = `${old.compartmentNo}/${fuelName(old.fuelCode)}/${old.tons}吨/第${old.order}站${stationName(old.stationCode)}`;
    const newDesc = `${next.compartmentNo}/${fuelName(next.fuelCode)}/${next.tons}吨/第${next.order}站${stationName(next.stationCode)}`;

    old.void = true;
    // 同舱同品的修订视为同一批油连续生命周期：已卸量沿链继承；跨品/跨舱不继承
    const sameCargo = next.compartmentNo === old.compartmentNo && next.fuelCode === old.fuelCode;
    const carried = sameCargo ? (old.carriedDeliveredTons ?? 0) + old.deliveredTons : 0;
    const newEntry: LoadEntry = {
      ...next,
      id: uid("load"),
      deliveredTons: 0,
      carriedDeliveredTons: carried,
      supersedes: old.id
    };
    trip.loads.push(newEntry);
    addRevision(trip, "舱位计划", old.compartmentNo, oldDesc, newDesc, reason);

    // 按修订链根载量做物理平衡挂账；只对涉及的"舱×油品"组补挂，已挂账只补差
    const affectedGroups = [
      { no: old.compartmentNo, fuel: old.fuelCode },
      ...(next.compartmentNo !== old.compartmentNo || next.fuelCode !== old.fuelCode
        ? [{ no: next.compartmentNo, fuel: next.fuelCode }]
        : [])
    ];
    const idMap = new Map(trip.loads.map((l) => [l.id, l]));
    affectedGroups.forEach(({ no, fuel }) => {
      const group = trip.loads.filter((l) => l.compartmentNo === no && l.fuelCode === fuel);
      const activeInGroup = group.filter((l) => !l.void);
      // 物理实装：修订链根节点计吨，跨舱/品转入不计
      const physicalLoaded = round2(
        group.reduce((acc, l) => {
          if (!l.supersedes) return acc + l.tons;
          const prev = idMap.get(l.supersedes);
          return prev && prev.compartmentNo === no && prev.fuelCode === fuel ? acc : acc;
        }, 0)
      );
      const effective = activeInGroup.length ? activeInGroup : group;
      const delivered = round2(effective.reduce((a, l) => a + deliveredOf(l), 0));
      const returned = round2(
        trip.returns
          .filter((r) => r.fuelCode === fuel)
          .flatMap((r) => r.allocated)
          .filter((a) => a.compartmentNo === no)
          .reduce((a, x) => a + x.tons, 0)
      );
      const newPlanned = round2(activeInGroup.reduce((a, l) => a + l.tons, 0));
      const alreadyPending = round2(
        trip.pending
          .filter((p) => p.kind === "revision" && p.compartmentNo === no && p.fuelCode === fuel)
          .reduce((a, p) => a + p.tons, 0)
      );
      // 舱存 = 实装 − 已卸 + 回装；超出新计划的油必须挂待处理（补差挂账）
      const onHand = round2(physicalLoaded - delivered + returned);
      const gap = round2(onHand - newPlanned - alreadyPending);
      if (gap > 1e-9) {
        trip.pending.push({
          id: uid("pend"),
          tripId: trip.id,
          plate: trip.plate,
          stationCode: old.stationCode,
          fuelCode: fuel,
          compartmentNo: no,
          tons: gap,
          kind: "revision",
          reason: `重开调整 ${no} 舱位计划（${reason.trim()}），舱存 ${onHand} 吨超出新计划 ${newPlanned} 吨，差额 ${gap} 吨转待处理`,
          createdAt: nowIso(),
          resolved: false
        });
      }
      // gap < 0（新计划多排无来源）不阻断编辑，由发车前冲突清单列出
    });
    persist();
    return { ok: true, message: "舱位计划已调整，旧值与原因已留存" };
  }

  /** 重开后作废某条装载计划（整舱油品已全部卸出或移出时使用），留修订痕迹 */
  function voidLoad(tripId: string, loadId: string, reason: string): ActionResult {
    const trip = getTrip(tripId);
    if (!trip) return { ok: false, message: "趟次不存在" };
    if (trip.status !== "重开") return { ok: false, message: "冻结中：请先重开本趟再调整" };
    if (!reason.trim()) return { ok: false, message: "调整必须填写原因" };
    const target = trip.loads.find((l) => l.id === loadId && !l.void);
    if (!target) return { ok: false, message: "装载行不存在" };
    // 按"舱×油品"组计算在舱量（跨品/跨舱转入的行本身无物理来源）
    const group = trip.loads.filter((l) => l.compartmentNo === target.compartmentNo && l.fuelCode === target.fuelCode);
    const idMap = new Map(trip.loads.map((l) => [l.id, l]));
    const physicalLoaded = round2(
      group.reduce((acc, l) => {
        if (!l.supersedes) return acc + l.tons;
        const prev = idMap.get(l.supersedes);
        return prev && prev.compartmentNo === target.compartmentNo && prev.fuelCode === target.fuelCode ? acc : acc;
      }, 0)
    );
    const delivered = round2(group.filter((l) => !l.void).reduce((a, l) => a + deliveredOf(l), 0));
    const returnedHere = round2(
      trip.returns
        .filter((r) => r.fuelCode === target.fuelCode)
        .flatMap((r) => r.allocated)
        .filter((a) => a.compartmentNo === target.compartmentNo)
        .reduce((a, x) => a + x.tons, 0)
    );
    const onHand = round2(physicalLoaded - delivered + returnedHere);
    if (onHand > 1e-9) {
      return { ok: false, message: `该舱该品尚有 ${onHand} 吨在舱，不能直接作废；请先安排卸油、退油或转待处理` };
    }
    target.void = true;
    addRevision(
      trip,
      "舱位计划",
      target.compartmentNo,
      `${target.compartmentNo}/${fuelName(target.fuelCode)}/${target.tons}吨/${stationName(target.stationCode)}`,
      "作废（舱已空，不再安排）",
      reason
    );
    persist();
    return { ok: true, message: "装载行已作废并留痕" };
  }

  /** 重开后调整到站顺序 */
  function reviseRouteOrder(tripId: string, route: string[], reason: string): ActionResult {
    const trip = getTrip(tripId);
    if (!trip) return { ok: false, message: "趟次不存在" };
    if (trip.status !== "重开") return { ok: false, message: "冻结中：请先重开本趟再调整" };
    if (new Set(route).size !== route.length) return { ok: false, message: "到站顺序存在重复站点" };
    if (route.length !== trip.route.length || route.some((c) => !trip.route.includes(c))) {
      return { ok: false, message: "只能调整顺序，不能增删站点" };
    }
    if (!reason.trim()) return { ok: false, message: "调整必须填写原因" };

    const oldDesc = trip.route.map((c, i) => `${i + 1}.${stationName(c)}`).join(" → ");
    const newDesc = route.map((c, i) => `${i + 1}.${stationName(c)}`).join(" → ");
    trip.route = [...route];
    trip.loads.filter((l) => !l.void).forEach((l) => {
      l.order = route.indexOf(l.stationCode) + 1;
    });
    addRevision(trip, "到站顺序", "路线", oldDesc, newDesc, reason);
    persist();
    return { ok: true, message: "到站顺序已调整" };
  }

  /** 重开后换车（车牌），按新车舱位重新校验 */
  function revisePlate(tripId: string, plate: string, reason: string): ActionResult {
    const trip = getTrip(tripId);
    if (!trip) return { ok: false, message: "趟次不存在" };
    if (trip.status !== "重开") return { ok: false, message: "冻结中：请先重开本趟再调整" };
    if (!getVehicle(plate)) return { ok: false, message: "车辆不存在" };
    if (!reason.trim()) return { ok: false, message: "调整必须填写原因" };

    const vehicle = getVehicle(plate)!;
    const drafts: LoadDraft[] = trip.loads.filter((l) => !l.void).map((l) => ({
      compartmentNo: l.compartmentNo,
      fuelCode: l.fuelCode,
      stationCode: l.stationCode,
      order: l.order,
      tons: l.tons
    }));
    const violations = validateLoads(vehicle, trip.route, drafts);
    if (violations.some((v) => v.level === "error")) {
      return { ok: false, violations, message: "换车后舱位/载重不匹配，请同步调整舱位计划" };
    }
    const oldPlate = trip.plate;
    trip.plate = plate;
    trip.pending.forEach((p) => (p.plate = plate));
    addRevision(trip, "车牌", "车辆", oldPlate, plate, reason);
    persist();
    return { ok: true, message: "车辆已更换" };
  }

  function conflictsOf(trip: Trip): ReopenConflict[] {
    return findReopenConflicts(trip, db.value.vehicles, db.value.fuels);
  }

  function resolvePending(tripId: string, pendingId: string, note: string): ActionResult {
    const trip = getTrip(tripId);
    const item = trip?.pending.find((p) => p.id === pendingId);
    if (!trip || !item) return { ok: false, message: "待处理项不存在" };
    item.resolved = true;
    item.resolveNote = note.trim() || "已线下处理";
    item.resolvedAt = nowIso();
    persist();
    return { ok: true, message: "待处理项已结清" };
  }

  function removeTrip(id: string) {
    db.value.trips = db.value.trips.filter((t) => t.id !== id);
    persist();
  }

  function resetAll() {
    db.value = buildSeedDatabase();
    persist();
  }

  return {
    // state
    db,
    vehicles,
    stations,
    fuels,
    trips,
    // helpers
    fuelName,
    stationName,
    getVehicle,
    getTrip,
    conflictsOf,
    // actions
    createTrip,
    depart,
    registerDelivery,
    registerReturn,
    complete,
    reopen,
    reviseLoad,
    voidLoad,
    reviseRouteOrder,
    revisePlate,
    resolvePending,
    removeTrip,
    resetAll
  };
});
