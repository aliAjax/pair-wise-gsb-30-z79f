/**
 * 资料层：油品、站点、罐车（分舱资料）基础数据与种子数据。
 * 只管"有什么资料"，不含判定逻辑。
 */
import type { Database, Trip } from "../types";

export const FUELS = [
  { code: "F92", name: "92号汽油" },
  { code: "F95", name: "95号汽油" },
  { code: "F0", name: "柴油" }
] as const;

export const STATIONS = [
  { code: "S-CD", name: "城东站" },
  { code: "S-JC", name: "机场站" },
  { code: "S-XQ", name: "新区站" },
  { code: "S-HG", name: "海港站" }
] as const;

/** 罐车资料：舱位、载重、限装油品 */
export const VEHICLES = [
  {
    plate: "鲁A·12345",
    model: "前四后八（30吨）",
    compartments: [
      { no: "1舱", capacity: 10, fuelCode: "F92" },
      { no: "2舱", capacity: 8 },
      { no: "3舱", capacity: 12, fuelCode: "F0" }
    ]
  },
  {
    plate: "鲁B·67890",
    model: "三轴罐车（22吨）",
    compartments: [
      { no: "1舱", capacity: 10, fuelCode: "F95" },
      { no: "2舱", capacity: 12 }
    ]
  },
  {
    plate: "鲁C·T9066",
    model: "双仓小车（15吨）",
    compartments: [
      { no: "1舱", capacity: 7, fuelCode: "F0" },
      { no: "2舱", capacity: 8, fuelCode: "F0" }
    ]
  }
] as const;

export function nowIso() {
  return new Date().toISOString();
}

/** 种子趟次：覆盖待发车 / 运输中（含退油溢出）/ 重开（含修订与冲突） */
function seedTrips(): Trip[] {
  const created = (offsetDays: number) =>
    new Date(Date.now() - offsetDays * 86400000).toISOString();

  const trip1: Trip = {
    id: "seed-1",
    plate: "鲁A·12345",
    route: ["S-JC", "S-XQ"],
    loads: [
      { id: "seed-1-l1", compartmentNo: "1舱", fuelCode: "F92", stationCode: "S-JC", order: 1, tons: 10, deliveredTons: 0 },
      { id: "seed-1-l2", compartmentNo: "2舱", fuelCode: "F95", stationCode: "S-XQ", order: 2, tons: 8, deliveredTons: 0 },
      { id: "seed-1-l3", compartmentNo: "3舱", fuelCode: "F0", stationCode: "S-XQ", order: 2, tons: 12, deliveredTons: 0 }
    ],
    returns: [],
    revisions: [],
    pending: [],
    status: "待发车",
    notes: "等待装车复核",
    createdAt: created(1)
  };

  const trip2: Trip = {
    id: "seed-2",
    plate: "鲁B·67890",
    route: ["S-CD", "S-HG"],
    loads: [
      { id: "seed-2-l1", compartmentNo: "1舱", fuelCode: "F95", stationCode: "S-CD", order: 1, tons: 10, deliveredTons: 10 },
      { id: "seed-2-l2", compartmentNo: "2舱", fuelCode: "F92", stationCode: "S-HG", order: 2, tons: 7, deliveredTons: 0 }
    ],
    returns: [
      {
        id: "seed-2-r1",
        tripId: "seed-2",
        stationCode: "S-CD",
        order: 1,
        fuelCode: "F95",
        tons: 13,
        allocated: [{ compartmentNo: "1舱", tons: 10 }],
        overflowTons: 3,
        createdAt: created(0)
      }
    ],
    revisions: [],
    pending: [
      {
        id: "seed-2-p1",
        tripId: "seed-2",
        plate: "鲁B·67890",
        stationCode: "S-CD",
        fuelCode: "F95",
        compartmentNo: "1舱",
        tons: 3,
        kind: "overflow" as const,
        reason: "退油13吨，1舱原品空舱余量仅10吨，超出3吨转待处理",
        createdAt: created(0),
        resolved: false
      }
    ],
    status: "运输中",
    notes: "城东站已收油并退油，下一站海港站",
    createdAt: created(2),
    departAt: created(1)
  };

  const trip3: Trip = {
    id: "seed-3",
    plate: "鲁C·T9066",
    route: ["S-HG"],
    loads: [
      { id: "seed-3-l1", compartmentNo: "1舱", fuelCode: "F0", stationCode: "S-HG", order: 1, tons: 7, deliveredTons: 7 },
      // 2舱柴油4吨为跨品修订转入，在2舱柴油组无物理来源（演示冲突）
      { id: "seed-3-l2", compartmentNo: "2舱", fuelCode: "F0", stationCode: "S-HG", order: 1, tons: 4, deliveredTons: 0, supersedes: "seed-3-l0" },
      // 2舱95号汽油5吨已卸3吨，重开跨品改柴油后整组作废，舱内余2吨
      { id: "seed-3-l0", compartmentNo: "2舱", fuelCode: "F95", stationCode: "S-HG", order: 1, tons: 5, deliveredTons: 3, void: true }
    ],
    returns: [],
    revisions: [
      {
        id: "seed-3-rv1",
        tripId: "seed-3",
        field: "舱位计划",
        label: "2舱",
        oldValue: "95号汽油 5吨 → 海港站",
        newValue: "柴油 4吨 → 海港站",
        reason: "到站复测罐容不足，调度改为柴油补舱，原95号汽油剩余2吨待回收",
        createdAt: created(3)
      },
      {
        id: "seed-3-rv2",
        tripId: "seed-3",
        field: "到站顺序",
        label: "海港站",
        oldValue: "顺序2（新区站 → 海港站）",
        newValue: "顺序1（海港站）",
        reason: "新区站暂停接卸，先送海港站",
        createdAt: created(3)
      }
    ],
    pending: [
      {
        id: "seed-3-p1",
        tripId: "seed-3",
        plate: "鲁C·T9066",
        stationCode: "S-HG",
        fuelCode: "F95",
        compartmentNo: "2舱",
        tons: 2,
        kind: "revision",
        reason: "2舱95号汽油5吨已卸3吨，重开跨品改装柴油，舱内剩余2吨转待处理回收",
        createdAt: created(3),
        resolved: false
      }
    ],
    status: "重开",
    notes: "海港站部分接卸后重开：2舱改装柴油4吨无物理来源（冲突），95号汽油2吨待回收，复核后才能发车",
    createdAt: created(4),
    departAt: created(3),
    reopenAt: created(3)
  };

  return [trip1, trip2, trip3];
}

export function buildSeedDatabase(): Database {
  return {
    vehicles: VEHICLES.map((v) => ({ ...v, compartments: v.compartments.map((c) => ({ ...c })) })),
    stations: STATIONS.map((s) => ({ ...s })),
    fuels: FUELS.map((f) => ({ ...f })),
    trips: seedTrips()
  };
}
