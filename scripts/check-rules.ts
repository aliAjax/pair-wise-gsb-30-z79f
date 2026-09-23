import { validateLoads, validateStops, allocateReturn, validateDelivery, reconcile } from "../src/logic/rules";
import { TRUCKS } from "../src/data/catalog";
import type { Trip, PendingItem } from "../src/types";

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean, extra?: unknown) {
  if (condition) {
    pass += 1;
  } else {
    fail += 1;
    console.error("FAIL:", name, extra ?? "");
  }
}

const truck = TRUCKS[1]; // 鲁B·6093 5仓
const codes = truck.compartments.map((c) => c.code);

// 1. 同舱跨品 -> 整趟退回
const cross = validateLoads(truck.plate, [
  { compartment: "1舱", product: "92号汽油", weight: 3 },
  { compartment: "1舱", product: "0号柴油", weight: 2 }
], codes);
check("跨品混装被拦截", cross.issues.some((i) => i.message.includes("跨品")));

// 2. 同舱同品多行合并
const merged = validateLoads(truck.plate, [
  { compartment: "1舱", product: "92号汽油", weight: 3 },
  { compartment: "1舱", product: "92号汽油", weight: 2 }
], codes);
check("同品合并为5且无问题", merged.loads.length === 1 && merged.loads[0].weight === 5 && merged.issues.length === 0);

// 3. 超量
const over = validateLoads(truck.plate, [{ compartment: "1舱", product: "92号汽油", weight: 7 }], codes);
check("超核定载重被拦截", over.issues.some((i) => i.message.includes("超过核定载重")));

// 4. 非该车舱位
const foreign = validateLoads(truck.plate, [{ compartment: "7舱", product: "92号汽油", weight: 1 }], codes);
check("非本车舱位被拦截", foreign.issues.some((i) => i.message.includes("不属于") || i.message.includes("舱位表")));

// 构造一趟在途：1舱6吨92，2舱5吨柴油；当前站第1站城东站
function makeTrip(): Trip {
  return {
    id: "t1", code: "PS-TEST", plate: truck.plate, departAt: "2026-07-01",
    status: "运输中", frozen: true, adjustUnlocked: false, currentStopIndex: 0,
    note: "", createdAt: new Date().toISOString(),
    loads: [
      { compartment: "1舱", product: "92号汽油", weight: 6 },
      { compartment: "2舱", product: "0号柴油", weight: 5 }
    ],
    stops: [
      { station: "城东站", order: 1, demands: { "92号汽油": 2 } },
      { station: "机场站", order: 2, demands: { "0号柴油": 5, "92号汽油": 4 } }
    ],
    deliveries: [], returns: [], revisions: []
  };
}

// 5. 退油只能回原品：退柴油，1舱是汽油不能入；2舱已满5吨(核定5) -> 全量转待处理
let trip = makeTrip();
let ret = allocateReturn(trip, "0号柴油", 3);
check("无原品空舱时退油全量转待处理", ret.overflow === 3 && ret.allocations.length === 0, ret);

// 6. 本站先交付2吨92，再退3吨92 -> 1舱腾出2吨入2吨，剩1吨转待处理（不压占机场站需要的4吨92？）
trip = makeTrip();
const dep = validateDelivery(trip, {
  station: "城东站", compartment: "1舱", product: "92号汽油", weight: 2
});
check("交付2吨合法", dep.length === 0, dep);
trip.deliveries.push({
  id: "d1", station: "城东站", compartment: "1舱", product: "92号汽油",
  weight: 2, at: new Date().toISOString()
});
ret = allocateReturn(trip, "92号汽油", 3);
check("本站卸空腾出舱位可接退油2吨", ret.allocations.reduce((s, a) => s + a.weight, 0) === 2, ret);
check("超出1吨转待处理", ret.overflow === 1, ret);
// 加上入舱后，机场站在舱92 = 6 - 2 + 2 = 6，不影响其4吨需求
trip.returns.push({
  id: "r1", station: "城东站", product: "92号汽油", requested: 3,
  allocated: 2, allocations: ret.allocations, overflow: 1,
  note: "", at: new Date().toISOString()
});
const pending: PendingItem[] = [{
  id: "p1", tripId: "t1", tripCode: "PS-TEST", plate: truck.plate, station: "城东站",
  product: "92号汽油", weight: 1, reason: "test", createdAt: new Date().toISOString(),
  handled: false, handledNote: "", handledAt: ""
}];

// 7. 跨品交付被拦截
trip = makeTrip();
const wrong = validateDelivery(trip, {
  station: "城东站", compartment: "2舱", product: "92号汽油", weight: 1
});
check("跨品交付被拦截", wrong.some((i) => i.message.includes("装载的是")));

// 8. 超余量交付被拦截
const tooMuch = validateDelivery(trip, {
  station: "城东站", compartment: "1舱", product: "92号汽油", weight: 9
});
check("超余量交付被拦截", tooMuch.some((i) => i.message.includes("可卸余量")));

// 9. 待处理挂账产生车牌级冲突
trip = makeTrip();
const conflicts = reconcile(trip, pending);
check("未办结待处理产生车牌级冲突", conflicts.some((c) => c.scope === "车牌" && c.product === "92号汽油" && c.diff === 1), conflicts);

// 10. 正常完成的趟次无冲突
const done = makeTrip();
done.status = "已到站";
done.deliveries = [
  { id: "a", station: "城东站", compartment: "1舱", product: "92号汽油", weight: 2, at: "" },
  { id: "b", station: "机场站", compartment: "1舱", product: "92号汽油", weight: 4, at: "" },
  { id: "c", station: "机场站", compartment: "2舱", product: "0号柴油", weight: 5, at: "" }
];
const noConflicts = reconcile(done, []);
check("全程正常无冲突", noConflicts.length === 0, noConflicts);

// 11. 顺序重复校验
const badStops = validateStops([
  { station: "城东站", order: 1, demands: {} },
  { station: "机场站", order: 1, demands: {} }
]);
check("到站顺序重复被拦截", badStops.some((i) => i.message.includes("顺序不能重复")));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
