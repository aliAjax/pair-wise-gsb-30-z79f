/**
 * 存储层生命周期冒烟测试（npx vite-node 运行）。
 */
import { createPinia, setActivePinia } from "pinia";
import { useDeliveryStore } from "../src/stores/delivery.ts";

class MemStorage {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
// @ts-expect-error 测试环境垫片
globalThis.localStorage = new MemStorage();

let pass = 0;
function check(name: string, cond: boolean, extra = "") {
  if (!cond) {
    console.error(`✗ ${name} ${extra}`);
    process.exit(1);
  }
  pass += 1;
  console.log(`✓ ${name}`);
}

setActivePinia(createPinia());
const store = useDeliveryStore();
store.resetAll();

// 1. 超量整趟退回，趟次数不增加（鲁A 2舱额定8，装99）
const before = store.trips.length;
const bad = store.createTrip("鲁A·12345", ["S-CD"], [
  { compartmentNo: "2舱", fuelCode: "F95", stationCode: "S-CD", order: 1, tons: 99 }
], "");
check("超量整趟退回", !bad.ok && store.trips.length === before);

// 2. 合法趟次：鲁A 1舱F92×10、2舱F95×8 均送城东站 → 发车冻结
const created = store.createTrip("鲁A·12345", ["S-CD"], [
  { compartmentNo: "1舱", fuelCode: "F92", stationCode: "S-CD", order: 1, tons: 10 },
  { compartmentNo: "2舱", fuelCode: "F95", stationCode: "S-CD", order: 1, tons: 8 }
], "测试趟");
check("合法趟次创建", created.ok, created.message ?? "");
const trip = store.trips[0];
check("发车成功", store.depart(trip.id).ok);

// 3. 冻结中调整被拒、重开必须填原因
const frozen = store.reviseLoad(trip.id, trip.loads[0].id, { tons: 8 }, "想改");
check("冻结期修订被拒", !frozen.ok);
check("重开必须填原因", !store.reopen(trip.id, "  ").ok);

// 4. 城东站：1舱F92卸6吨；2舱F95卸8吨全部卸空 → 重开
check("到站卸油(6+8)",
  store.registerDelivery(trip.id, [
    { loadId: trip.loads[0].id, tons: 6 },
    { loadId: trip.loads[1].id, tons: 8 }
  ]).ok);
check("重开成功", store.reopen(trip.id, "现场变更").ok);

// 5. 同舱同品改量 1舱F92 10→4：4吨仍在舱且仍排本站 → 物理平衡，无挂账无冲突
const f92 = trip.loads.find((l) => l.fuelCode === "F92" && !l.void)!;
const rv = store.reviseLoad(trip.id, f92.id, { tons: 4 }, "站方只接4吨，4吨留存舱内带回");
check("同舱同品改量成功", rv.ok, rv.message ?? "");
check("同舱改量不产生挂账", !trip.pending.some((p) => p.kind === "revision"));
check("同舱改量无冲突", store.conflictsOf(trip).length === 0,
  JSON.stringify(store.conflictsOf(trip).map((x) => x.detail)));

// 6. 跨品误修订：2舱F95已卸空，却改排 F92 4吨（无物理来源）
//    → 冲突清单列出 车牌/舱号/油品/差额(-4)，阻断发车
const f95 = trip.loads.find((l) => l.fuelCode === "F95" && !l.void)!;
const rvCross = store.reviseLoad(trip.id, f95.id,
  { compartmentNo: "2舱", fuelCode: "F92", stationCode: "S-CD", order: 1, tons: 4 },
  "误操作：空舱改排92号汽油");
check("跨品修订可提交（保留现场再核对）", rvCross.ok, rvCross.message ?? "");
const conflicts = store.conflictsOf(trip);
const c = conflicts.find((x) => x.compartmentNo === "2舱" && x.fuelCode === "F92");
check("冲突列出车牌/舱号/油品/差额",
  !!c && c.plate === "鲁A·12345" && Math.abs(c.diffTons + 4) < 1e-9,
  JSON.stringify(conflicts.map((x) => x.detail)));
check("有冲突不能发车", !store.depart(trip.id).ok);

// 7. 更正：空舱不再排货，作废该无来源计划行（强制填原因）→ 冲突消解 → 发车
const f92wrong = trip.loads.find((l) => l.compartmentNo === "2舱" && l.fuelCode === "F92" && !l.void)!;
check("作废必须填原因", !store.voidLoad(trip.id, f92wrong.id, "  ").ok);
check("作废无货计划行", store.voidLoad(trip.id, f92wrong.id, "空舱回库，不捎货").ok);
check("作废后冲突消解", store.conflictsOf(trip).length === 0,
  JSON.stringify(store.conflictsOf(trip).map((x) => x.detail)));
check("更正后重新发车", store.depart(trip.id).ok);

// 8. 退油溢出（独立趟次）：卸空10吨后退油13吨 → 回装10、溢出3转待处理、不压后续站
const t2res = store.createTrip("鲁B·67890", ["S-CD"], [
  { compartmentNo: "1舱", fuelCode: "F95", stationCode: "S-CD", order: 1, tons: 10 }
], "退油趟");
check("第二趟创建", t2res.ok);
const trip2 = store.trips[0];
store.depart(trip2.id);
store.registerDelivery(trip2.id, [{ loadId: trip2.loads[0].id, tons: 10 }]);
const ret = store.registerReturn(trip2.id, "S-CD", "F95", 13, ["1舱", "2舱"]);
check("退油回装10、溢出3转待处理、不压后续站",
  ret.ok &&
  trip2.returns[0].allocated[0].tons === 10 &&
  trip2.pending.some((p) => p.kind === "overflow" && Math.abs(p.tons - 3) < 1e-9),
  ret.message ?? "");
check("退油趟账目无冲突", store.conflictsOf(trip2).length === 0);

console.log(`\n全部 ${pass} 项生命周期判定通过`);
