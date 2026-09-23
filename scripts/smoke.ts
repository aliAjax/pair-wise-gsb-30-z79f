/**
 * 判定层冒烟测试（非交付文件，npx vite-node 运行）：
 * 覆盖 同舱跨品/超量整趟退回、退油不压后续站、溢出转待处理、重开冲突列报。
 */
import { assert } from "node:console";
import { buildSeedDatabase } from "../src/data/catalog.ts";
import {
  compartmentReturnCapacity,
  findReopenConflicts,
  planReturn,
  validateLoads
} from "../src/domain/rules.ts";

let pass = 0;
function check(name: string, cond: boolean, extra = "") {
  if (!cond) {
    console.error(`✗ ${name} ${extra}`);
    process.exit(1);
  }
  pass += 1;
  console.log(`✓ ${name}`);
}

const db = buildSeedDatabase();
const vehicleA = db.vehicles[0]; // 鲁A 1舱10t限F92 / 2舱8t / 3舱12t限F0

// 1. 同舱跨品 → 整趟报错
const mixed = validateLoads(vehicleA, ["S-CD", "S-JC"], [
  { compartmentNo: "2舱", fuelCode: "F92", stationCode: "S-CD", order: 1, tons: 4 },
  { compartmentNo: "2舱", fuelCode: "F95", stationCode: "S-JC", order: 2, tons: 4 }
]);
check("同舱跨品应报错", mixed.some((v) => v.type === "fuel"));

// 2. 超量 → 整趟报错（2舱额定8，装9）
const over = validateLoads(vehicleA, ["S-CD"], [
  { compartmentNo: "2舱", fuelCode: "F95", stationCode: "S-CD", order: 1, tons: 9 }
]);
check("舱位超量应报错", over.some((v) => v.type === "compartment"));

// 3. 限装舱装错品
const wrongFuel = validateLoads(vehicleA, ["S-CD"], [
  { compartmentNo: "1舱", fuelCode: "F0", stationCode: "S-CD", order: 1, tons: 5 }
]);
check("限装舱错品应报错", wrongFuel.some((v) => v.type === "fuel"));

// 4. 合法计划通过
const ok = validateLoads(vehicleA, ["S-CD", "S-JC"], [
  { compartmentNo: "1舱", fuelCode: "F92", stationCode: "S-CD", order: 1, tons: 10 },
  { compartmentNo: "2舱", fuelCode: "F95", stationCode: "S-JC", order: 2, tons: 8 }
]);
check("合法装载无错误", ok.every((v) => v.level !== "error"), JSON.stringify(ok));

// 5. 退油：seed-2 运输中，城东站（顺序1）；清掉种子自带退油记录后测余量
const trip2base = structuredClone(db.trips.find((t) => t.id === "seed-2")!);
trip2base.returns = [];
trip2base.pending = [];
// 1舱 F95 在城东站应卸10、已卸10 → 可回装10
const cap = compartmentReturnCapacity(trip2base, 1, "1舱", "F95");
check("原品空舱余量=本站已卸10", cap.ok && cap.capacity === 10, JSON.stringify(cap));
// 不能用后续站点舱容：2舱F92是海港站的，在城东站退F92不允许
const capLater = compartmentReturnCapacity(trip2base, 1, "2舱", "F92");
check("不得压占后续站点舱容", capLater.ok === false && capLater.capacity === 0, JSON.stringify(capLater));
// 跨品不可回
const capWrong = compartmentReturnCapacity(trip2base, 1, "1舱", "F0");
check("退油跨品被拒", capWrong.ok === false);

// 6. planReturn：申报13，只有1舱10余量 → 回装10、溢出3
const plan = planReturn(structuredClone(trip2base), 1, "F95", 13, ["1舱", "2舱"]);
check("退油回装10", plan.allocated[0].tons === 10);
check("溢出3转待处理", plan.overflowTons === 3, String(plan.overflowTons));

// 6b. 已回装过10后再次退油，同舱余量应被扣减，不重复占用
const trip2partial = structuredClone(trip2base);
trip2partial.returns.push({
  id: "r-x", tripId: trip2partial.id, stationCode: "S-CD", order: 1, fuelCode: "F95",
  tons: 10, allocated: [{ compartmentNo: "1舱", tons: 10 }], overflowTons: 0, createdAt: ""
});
const capAgain = compartmentReturnCapacity(trip2partial, 1, "1舱", "F95");
check("回装占用后余量归零", capAgain.ok && capAgain.capacity === 0, JSON.stringify(capAgain));

// 7. 重开冲突：seed-3 的 2舱柴油（跨品转入无来源）应列 -4 差额；95号汽油2吨已挂账平衡
const trip3 = db.trips.find((t) => t.id === "seed-3")!;
const conflicts = findReopenConflicts(trip3, db.vehicles, db.fuels);
const cF0 = conflicts.find((c) => c.compartmentNo === "2舱" && c.fuelCode === "F0");
check("重开冲突列出车牌", cF0?.plate === "鲁C·T9066");
check("重开冲突列出舱号与油品", cF0?.compartmentNo === "2舱" && cF0?.fuelName === "柴油");
check("重开冲突差额-4吨（多排无来源）", cF0?.diffTons === -4, String(cF0?.diffTons));
const c95 = conflicts.find((c) => c.compartmentNo === "2舱" && c.fuelCode === "F95");
check("95号汽油2吨已挂账不产生冲突", !c95, JSON.stringify(c95));
// seed-2（带种子退油+挂账3吨）退油账目平衡，不应产生冲突
const trip2 = db.trips.find((t) => t.id === "seed-2")!;
const c2 = findReopenConflicts(trip2, db.vehicles, db.fuels);
check("seed-2退油记录账目平衡无冲突", c2.length === 0, JSON.stringify(c2.map((x) => x.detail)));

console.log(`\n全部 ${pass} 项判定通过`);
void assert;
