import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { getTruck } from "../data/catalog";
import { seedTrips } from "../data/seed";
import {
  allocateReturn,
  reconcile,
  validateDelivery,
  validateLoadEdit,
  validateLoads,
  validateStops
} from "../logic/rules";
import type {
  Delivery,
  FuelReturn,
  LoadDraft,
  PendingItem,
  Revision,
  StationStop,
  Trip,
  TripConflict,
  ValidationIssue
} from "../types";
import {
  loadProduct,
  now,
  originalLoad,
  round3,
  sortedStops,
  uid
} from "../logic/helpers";

const STORAGE_KEY = "hxwlfront-19-oil-delivery-v2";

interface PersistShape {
  trips: Trip[];
  pendings: PendingItem[];
  seq: number;
}

function loadState(): PersistShape {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as PersistShape;
      if (Array.isArray(parsed.trips)) {
        return {
          trips: parsed.trips,
          pendings: parsed.pendings ?? [],
          seq: parsed.seq ?? 100
        };
      }
    } catch {
      // 损坏数据回退种子
    }
  }
  return { trips: seedTrips(), pendings: seedPendings(), seq: 100 };
}

function seedPendings(): PendingItem[] {
  return [
    {
      id: "seed-pending-1",
      tripId: "seed-trip-2",
      tripCode: "PS20260701-02",
      plate: "鲁B·7218",
      station: "城东站",
      product: "95号汽油",
      weight: 1,
      reason: "原品舱已满载，退油入不下，不压占后续机场站/新区站",
      createdAt: "2026-07-01T09:45:00.000Z",
      handled: false,
      handledNote: "",
      handledAt: ""
    }
  ];
}

export interface ActionResult {
  ok: boolean;
  issues: ValidationIssue[];
  warnings: ValidationIssue[];
}

const OK: ActionResult = { ok: true, issues: [], warnings: [] };

export const useTripStore = defineStore("trips", () => {
  const initial = loadState();
  const trips = ref<Trip[]>(initial.trips);
  const pendings = ref<PendingItem[]>(initial.pendings);
  const seq = ref(initial.seq);

  function persist() {
    const data: PersistShape = { trips: trips.value, pendings: pendings.value, seq: seq.value };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }

  function nextTripCode(): string {
    seq.value += 1;
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    return `PS${date}-${String(seq.value).slice(-2)}`;
  }

  function getTrip(id: string): Trip | undefined {
    return trips.value.find((item) => item.id === id);
  }

  /** 新建趟次：校验不过（跨品/超量/舱不符）整趟退回，不写存储 */
  function createTrip(input: {
    plate: string;
    departAt: string;
    note: string;
    loads: LoadDraft[];
    stops: StationStop[];
  }): ActionResult & { tripId?: string } {
    const truck = getTruck(input.plate);
    if (!truck) return { ok: false, issues: [{ message: "请选择车辆" }], warnings: [] };

    const { loads, issues: loadIssues } = validateLoads(
      input.plate,
      input.loads,
      truck.compartments.map((item) => item.code)
    );
    const stopIssues = validateStops(input.stops);
    const issues = [...loadIssues, ...stopIssues];
    if (issues.length > 0) {
      return { ok: false, issues, warnings: [] };
    }

    const trip: Trip = {
      id: uid("trip"),
      code: nextTripCode(),
      plate: input.plate,
      departAt: input.departAt,
      status: "待发车",
      frozen: false,
      adjustUnlocked: false,
      currentStopIndex: 0,
      note: input.note || "暂无备注",
      createdAt: now(),
      loads: loads.map((item) => ({ ...item })),
      stops: sortedStops(input.stops).map((stop) => ({
        station: stop.station,
        order: stop.order,
        demands: { ...stop.demands }
      })),
      deliveries: [],
      returns: [],
      revisions: []
    };
    trips.value = [trip, ...trips.value];
    persist();
    return { ok: true, issues: [], warnings: [], tripId: trip.id };
  }

  /** 发车前直接编辑装载（未冻结，不留痕） */
  function editLoads(tripId: string, drafts: LoadDraft[]): ActionResult {
    const trip = getTrip(tripId);
    if (!trip) return { ok: false, issues: [{ message: "趟次不存在" }], warnings: [] };
    if (trip.frozen) {
      return { ok: false, issues: [{ message: "发车后舱位已冻结，请使用载重调整或先重开行程" }], warnings: [] };
    }
    const truck = getTruck(trip.plate);
    const { loads, issues } = validateLoads(
      trip.plate,
      drafts,
      truck ? truck.compartments.map((item) => item.code) : []
    );
    if (issues.length) return { ok: false, issues, warnings: [] };
    trip.loads = loads.map((item) => ({ ...item }));
    persist();
    return OK;
  }

  function editStops(tripId: string, stops: StationStop[]): ActionResult {
    const trip = getTrip(tripId);
    if (!trip) return { ok: false, issues: [{ message: "趟次不存在" }], warnings: [] };
    if (trip.frozen && !trip.adjustUnlocked) {
      return { ok: false, issues: [{ message: "到站顺序已冻结，需先重开行程并填写原因" }], warnings: [] };
    }
    const issues = validateStops(stops);
    if (issues.length) return { ok: false, issues, warnings: [] };
    trip.stops = sortedStops(stops).map((stop) => ({
      station: stop.station,
      order: stop.order,
      demands: { ...stop.demands }
    }));
    if (trip.currentStopIndex > trip.stops.length - 1) {
      trip.currentStopIndex = trip.stops.length - 1;
    }
    persist();
    return OK;
  }

  /** 发车：舱位与到站顺序冻结 */
  function depart(tripId: string): ActionResult {
    const trip = getTrip(tripId);
    if (!trip) return { ok: false, issues: [{ message: "趟次不存在" }], warnings: [] };
    if (trip.frozen) return { ok: false, issues: [{ message: "该趟次已发车" }], warnings: [] };
    const issues = validateStops(trip.stops);
    if (issues.length) return { ok: false, issues, warnings: [] };
    trip.frozen = true;
    trip.status = "运输中";
    trip.currentStopIndex = 0;
    persist();
    return OK;
  }

  /** 到站交付登记 */
  function addDelivery(
    tripId: string,
    draft: { station: string; compartment: string; product: string; weight: number }
  ): ActionResult {
    const trip = getTrip(tripId);
    if (!trip) return { ok: false, issues: [{ message: "趟次不存在" }], warnings: [] };
    const issues = validateDelivery(trip, draft);
    if (issues.length) return { ok: false, issues, warnings: [] };
    const delivery: Delivery = { ...draft, weight: round3(draft.weight), id: uid("d"), at: now() };
    trip.deliveries.push(delivery);
    persist();
    return OK;
  }

  /** 站方退油：只回原品空舱，超出余量转待处理 */
  function addReturn(
    tripId: string,
    draft: { product: string; weight: number; note: string }
  ): ActionResult {
    const trip = getTrip(tripId);
    if (!trip) return { ok: false, issues: [{ message: "趟次不存在" }], warnings: [] };
    const current = sortedStops(trip.stops)[trip.currentStopIndex];
    if (!current) return { ok: false, issues: [{ message: "当前没有停靠站" }], warnings: [] };

    const { allocations, overflow, issues } = allocateReturn(trip, draft.product, draft.weight);
    if (issues.some((item) => item.message.includes("必须"))) {
      return { ok: false, issues, warnings: [] };
    }
    const record: FuelReturn = {
      id: uid("r"),
      station: current.station,
      product: draft.product,
      requested: round3(draft.weight),
      allocated: round3(allocations.reduce((sum, item) => sum + item.weight, 0)),
      allocations,
      overflow,
      note: draft.note,
      at: now()
    };
    trip.returns.push(record);
    if (overflow > 1e-9) {
      pendings.value.push({
        id: uid("pending"),
        tripId: trip.id,
        tripCode: trip.code,
        plate: trip.plate,
        station: current.station,
        product: draft.product,
        weight: overflow,
        reason: "原品空舱余量不足，退油入不下；已转待处理，未压占后续站点",
        createdAt: now(),
        handled: false,
        handledNote: "",
        handledAt: ""
      });
    }
    persist();
    return { ok: true, issues: [], warnings: issues };
  }

  /** 前往下一站 / 完成最后一站 */
  function advanceStop(tripId: string): ActionResult {
    const trip = getTrip(tripId);
    if (!trip) return { ok: false, issues: [{ message: "趟次不存在" }], warnings: [] };
    if (!trip.frozen) return { ok: false, issues: [{ message: "尚未发车" }], warnings: [] };
    if (trip.currentStopIndex >= trip.stops.length - 1) {
      trip.status = "已到站";
      persist();
      return OK;
    }
    trip.currentStopIndex += 1;
    persist();
    return OK;
  }

  /** 重开当前站点：可补录本站交付/退油，记录原因与旧值 */
  function reopenStop(tripId: string, reason: string): ActionResult {
    const trip = getTrip(tripId);
    if (!trip) return { ok: false, issues: [{ message: "趟次不存在" }], warnings: [] };
    if (!reason.trim()) return { ok: false, issues: [{ message: "必须填写重开原因" }], warnings: [] };
    const stops = sortedStops(trip.stops);
    const current = stops[trip.currentStopIndex];
    if (!current) return { ok: false, issues: [{ message: "没有可重开的站点" }], warnings: [] };
    const revision: Revision = {
      id: uid("rev"),
      at: now(),
      reason: reason.trim(),
      changes: [
        {
          field: "到站重开",
          target: current.station,
          oldValue: `已离开第${current.order}站`,
          newValue: `回到第${current.order}站`,
          diff: 0
        }
      ]
    };
    trip.revisions.push(revision);
    if (trip.status === "已到站") trip.status = "运输中";
    persist();
    return OK;
  }

  /** 重开行程：解锁舱位油品与到站顺序调整 */
  function reopenTrip(tripId: string, reason: string): ActionResult {
    const trip = getTrip(tripId);
    if (!trip) return { ok: false, issues: [{ message: "趟次不存在" }], warnings: [] };
    if (!reason.trim()) return { ok: false, issues: [{ message: "必须填写重开原因" }], warnings: [] };
    if (trip.adjustUnlocked) {
      return { ok: false, issues: [{ message: "行程已处于重开状态" }], warnings: [] };
    }
    trip.adjustUnlocked = true;
    if (trip.status === "已到站") trip.status = "运输中";
    trip.revisions.push({
      id: uid("rev"),
      at: now(),
      reason: reason.trim(),
      changes: [
        {
          field: "行程重开",
          target: trip.code,
          oldValue: "冻结",
          newValue: "重开可调整",
          diff: 0
        }
      ]
    });
    persist();
    return OK;
  }

  /** 载重调整：发车后也允许，但必须留原因和旧值 */
  function adjustWeight(
    tripId: string,
    compartment: string,
    newWeight: number,
    reason: string
  ): ActionResult {
    const trip = getTrip(tripId);
    if (!trip) return { ok: false, issues: [{ message: "趟次不存在" }], warnings: [] };
    if (!reason.trim()) return { ok: false, issues: [{ message: "必须填写调整原因" }], warnings: [] };
    const issues = validateLoadEdit(trip, compartment, { weight: newWeight });
    if (issues.length) return { ok: false, issues, warnings: [] };

    // 旧值取当前账面（含此前修订），保证连续修订仍对得上
    let oldWeight = originalLoad(trip, compartment)?.weight ?? 0;
    for (const revision of [...trip.revisions].sort((a, b) => a.at.localeCompare(b.at))) {
      for (const change of revision.changes) {
        if (change.field === "载重" && change.target === compartment) {
          oldWeight = round3(oldWeight + change.diff);
        }
      }
    }
    const diff = round3(newWeight - oldWeight);
    if (Math.abs(diff) < 1e-9) {
      return { ok: false, issues: [{ message: "载重没有变化", compartment }], warnings: [] };
    }
    trip.revisions.push({
      id: uid("rev"),
      at: now(),
      reason: reason.trim(),
      changes: [
        {
          field: "载重",
          target: compartment,
          product: loadProduct(trip, compartment),
          oldValue: String(oldWeight),
          newValue: String(round3(newWeight)),
          diff
        }
      ]
    });
    persist();
    return OK;
  }

  /** 油品调整：仅行程重开后可用，留原因与旧值 */
  function adjustProduct(
    tripId: string,
    compartment: string,
    newProduct: string,
    reason: string
  ): ActionResult {
    const trip = getTrip(tripId);
    if (!trip) return { ok: false, issues: [{ message: "趟次不存在" }], warnings: [] };
    if (!trip.frozen) {
      // 未发车直接改原始登记
      const load = originalLoad(trip, compartment);
      if (!load) return { ok: false, issues: [{ message: "舱位不存在", compartment }], warnings: [] };
      load.product = newProduct;
      persist();
      return OK;
    }
    if (!trip.adjustUnlocked) {
      return { ok: false, issues: [{ message: "舱位油品已冻结，需先重开行程" }], warnings: [] };
    }
    if (!reason.trim()) return { ok: false, issues: [{ message: "必须填写调整原因" }], warnings: [] };
    const oldProduct = loadProduct(trip, compartment);
    if (oldProduct === newProduct) {
      return { ok: false, issues: [{ message: "油品没有变化", compartment }], warnings: [] };
    }
    // 已有该品作业的舱不允许改品，保证配送、退油仍对应
    const used =
      trip.deliveries.some((item) => item.compartment === compartment) ||
      trip.returns.some((item) => item.allocations.some((a) => a.compartment === compartment));
    if (used) {
      return {
        ok: false,
        issues: [{ message: `${compartment} 已有交付/退油记录，不能改品`, compartment }],
        warnings: []
      };
    }
    trip.revisions.push({
      id: uid("rev"),
      at: now(),
      reason: reason.trim(),
      changes: [
        {
          field: "油品",
          target: compartment,
          product: oldProduct,
          oldValue: oldProduct,
          newValue: newProduct,
          diff: 0
        }
      ]
    });
    persist();
    return OK;
  }

  /** 到站顺序调整：仅行程重开后可用，逐站留旧值/新值 */
  function adjustOrder(
    tripId: string,
    next: { station: string; order: number }[],
    reason: string
  ): ActionResult {
    const trip = getTrip(tripId);
    if (!trip) return { ok: false, issues: [{ message: "趟次不存在" }], warnings: [] };
    if (!trip.adjustUnlocked) {
      return { ok: false, issues: [{ message: "到站顺序已冻结，需先重开行程" }], warnings: [] };
    }
    if (!reason.trim()) return { ok: false, issues: [{ message: "必须填写调整原因" }], warnings: [] };
    const oldMap = new Map(trip.stops.map((stop) => [stop.station, stop.order]));
    if (new Set(next.map((item) => item.order)).size !== next.length) {
      return { ok: false, issues: [{ message: "调整后的顺序不能重复" }], warnings: [] };
    }
    const changes = next
      .filter((item) => oldMap.get(item.station) !== item.order)
      .map((item) => ({
        field: "到站顺序" as const,
        target: item.station,
        oldValue: `第${oldMap.get(item.station)}位`,
        newValue: `第${item.order}位`,
        diff: 0
      }));
    if (!changes.length) return { ok: false, issues: [{ message: "顺序没有变化" }], warnings: [] };

    for (const item of next) {
      const stop = trip.stops.find((s) => s.station === item.station);
      if (stop) stop.order = item.order;
    }
    trip.stops = sortedStops(trip.stops);
    // 当前停靠下标跟随当前站点
    const currentStation = sortedStops(trip.stops)[trip.currentStopIndex]?.station;
    if (currentStation) {
      const stationNow = trip.stops.find((s) => s.station === currentStation);
      if (stationNow) trip.currentStopIndex = trip.stops.indexOf(stationNow);
    }
    trip.revisions.push({ id: uid("rev"), at: now(), reason: reason.trim(), changes });
    persist();
    return OK;
  }

  function handlePending(pendingId: string, note: string): ActionResult {
    const pending = pendings.value.find((item) => item.id === pendingId);
    if (!pending) return { ok: false, issues: [{ message: "待处理项不存在" }], warnings: [] };
    if (pending.handled) return { ok: false, issues: [{ message: "该待处理项已办结" }], warnings: [] };
    pending.handled = true;
    pending.handledNote = note.trim() || "现场已处置";
    pending.handledAt = now();
    persist();
    return OK;
  }

  function removeTrip(tripId: string) {
    trips.value = trips.value.filter((item) => item.id !== tripId);
    pendings.value = pendings.value.filter((item) => item.tripId !== tripId);
    persist();
  }

  const conflictsMap = computed(() => {
    const map = new Map<string, TripConflict[]>();
    for (const trip of trips.value) {
      map.set(trip.id, reconcile(trip, pendings.value));
    }
    return map;
  });

  function conflictsOf(tripId: string): TripConflict[] {
    return conflictsMap.value.get(tripId) ?? [];
  }

  return {
    trips,
    pendings,
    persist,
    getTrip,
    createTrip,
    editLoads,
    editStops,
    depart,
    addDelivery,
    addReturn,
    advanceStop,
    reopenStop,
    reopenTrip,
    adjustWeight,
    adjustProduct,
    adjustOrder,
    handlePending,
    removeTrip,
    conflictsOf
  };
});
