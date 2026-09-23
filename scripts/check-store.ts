// 端到端走查：localStorage shim + Pinia store
import { createPinia, setActivePinia } from "pinia";

const storeMap = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => storeMap.get(k) ?? null,
  setItem: (k: string, v: string) => storeMap.set(k, v),
  removeItem: (k: string) => storeMap.delete(k)
};
(globalThis as any).crypto ??= (await import("node:crypto")).webcrypto;

setActivePinia(createPinia());
const { useTripStore } = await import("../src/store/trips");

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean, extra?: unknown) {
  if (condition) pass++;
  else {
    fail++;
    console.error("FAIL:", name, JSON.stringify(extra));
  }
}

const store = useTripStore();
check("种子有3趟", store.trips.length === 3);
check("种子有1笔待处理", store.pendings.length === 1);

// A. 建趟：跨品 -> 整趟退回，趟次数不变
const before = store.trips.length;
const rejected = store.createTrip({
  plate: "鲁B·6093",
  departAt: "2026-07-03",
  note: "",
  loads: [
    { compartment: "1舱", product: "92号汽油", weight: 3 },
    { compartment: "1舱", product: "0号柴油", weight: 3 }
  ],
  stops: [{ station: "城东站", order: 1, demands: { "92号汽油": 3 } }]
});
check("跨品建趟失败且不写库", !rejected.ok && store.trips.length === before, rejected.issues);

// B. 合法建趟
const created = store.createTrip({
  plate: "鲁B·6093",
  departAt: "2026-07-03",
  note: "端到端测试",
  loads: [
    { compartment: "1舱", product: "92号汽油", weight: 6 },
    { compartment: "2舱", product: "0号柴油", weight: 5 }
  ],
  stops: [
    { station: "城东站", order: 1, demands: { "92号汽油": 6 } },
    { station: "机场站", order: 2, demands: { "0号柴油": 5 } }
  ]
});
check("合法建趟成功", created.ok, created.issues);
const tripId = created.tripId!;
const trip = store.getTrip(tripId)!;
check("新建趟为待发车且未冻结", trip.status === "待发车" && !trip.frozen);

// C. 发车前可改装载
const editOk = store.editLoads(tripId, [
  { compartment: "1舱", product: "92号汽油", weight: 5 },
  { compartment: "2舱", product: "0号柴油", weight: 5 }
]);
check("发车前可编辑装载", editOk.ok, editOk.issues);

// D. 发车冻结
const departed = store.depart(tripId);
check("发车成功", departed.ok);
const frozenEdit = store.editLoads(tripId, [
  { compartment: "1舱", product: "0号柴油", weight: 5 }
]);
check("发车后直接改装载被冻结拦截", !frozenEdit.ok);
const frozenOrder = store.editStops(tripId, [
  { station: "机场站", order: 1, demands: {} },
  { station: "城东站", order: 2, demands: {} }
]);
check("发车后改顺序被冻结拦截", !frozenOrder.ok);

// E. 无原因载重调整被拒
const noReason = store.adjustWeight(tripId, "1舱", 4.5, "  ");
check("载重调整无原因被拒", !noReason.ok);
const adjusted = store.adjustWeight(tripId, "1舱", 4.5, "过磅差0.5");
check("有原因载重调整成功", adjusted.ok, adjusted.issues);
check("调整留痕含旧值/新值/差额",
  trip.revisions.some((r) =>
    r.reason === "过磅差0.5" &&
    r.changes[0].oldValue === "5" &&
    r.changes[0].newValue === "4.5" &&
    r.changes[0].diff === -0.5
  ),
  trip.revisions
);

// F. 城东站交付：需求6，账面4.5 -> 交4.5
const d1 = store.addDelivery(tripId, {
  station: "城东站", compartment: "1舱", product: "92号汽油", weight: 4.5
});
check("城东站交付4.5成功", d1.ok, d1.issues);
const d2 = store.addDelivery(tripId, {
  station: "城东站", compartment: "1舱", product: "92号汽油", weight: 1
});
check("超余量再交被拒", !d2.ok);

// G. 退油：1舱卸空（核定6），退7吨92 -> 入6，1吨转待处理
const ret = store.addReturn(tripId, { product: "92号汽油", weight: 7, note: "清罐" });
check("退油入6吨", ret.ok, ret.issues);
const record = trip.returns[0];
check("退油入舱6吨且1吨转待处理",
  record.allocated === 6 && record.overflow === 1,
  record
);
check("待处理台账新增1笔",
  store.pendings.some((p) => p.tripId === tripId && p.weight === 1 && !p.handled)
);
check("超余量挂账产生车牌冲突",
  store.conflictsOf(tripId).some((c) => c.scope === "车牌" && c.diff === 1)
);

// H. 到下一站：机场站，2舱柴油5吨；顺序仍是城東->机场
const advance = store.advanceStop(tripId);
check("进入下一站", advance.ok);
check("当前站为机场站", trip.stops[trip.currentStopIndex].station === "机场站");
// 退入1舱的6吨92不应压占机场站（机场站不要92，2舱柴油仍5吨可交）
const d3 = store.addDelivery(tripId, {
  station: "机场站", compartment: "2舱", product: "0号柴油", weight: 5
});
check("后续站柴油可足额交付（未被压占）", d3.ok, d3.issues);

// I. 未重开不能改油品
const locked = store.adjustProduct(tripId, "1舱", "0号柴油", "试改");
check("未重开改油品被拒", !locked.ok);
// 已有作业的舱重开后也不能改品
store.reopenTrip(tripId, "调度要求");
const usedChange = store.adjustProduct(tripId, "1舱", "0号柴油", "改品测试");
check("已有交付/退油记录的舱不能改品", !usedChange.ok);
// 2舱也有交付；改用"油品调整"不可行，改为测试顺序调整留痕
const orderRes = store.adjustOrder(tripId,
  trip.stops.map((s) => ({
    station: s.station,
    order: s.station === "城东站" ? 2 : 1
  })),
  "道路管制互换"
);
check("重开后顺序调整成功并留旧值",
  orderRes.ok && trip.revisions.some((r) =>
    r.reason === "道路管制互换" &&
    r.changes.some((c) => c.field === "到站顺序" && c.target === "城东站")
  ),
  orderRes.issues
);

// J. 重开本站留痕
const reopen = store.reopenStop(tripId, "补录单据");
check("重开本站需留原因", reopen.ok && trip.revisions.some((r) =>
  r.reason === "补录单据" && r.changes[0].field === "到站重开"
));

// K. 办结待处理后冲突消失
const pending = store.pendings.find((p) => p.tripId === tripId && !p.handled)!;
store.handlePending(pending.id, "转自有库存");
check("待处理可办结", pending.handled);
check("办结后车牌冲突消失",
  !store.conflictsOf(tripId).some((c) => c.scope === "车牌" && c.product === "92号汽油")
);

// L. 全程完成：机场站柴油需求5已交，城东站92需求6实际交4.5（已到站时欠交提示）
store.advanceStop(tripId);
check("末站后状态为已到站", trip.status === "已到站");
check("已到站核对列出92欠交1.5",
  store.conflictsOf(tripId).some((c) =>
    c.target.includes("城东站") && c.product === "92号汽油" && c.diff === -1.5
  ),
  store.conflictsOf(tripId)
);

// M 持久化
check("数据已写入localStorage", storeMap.has("hxwlfront-19-oil-delivery-v2"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
