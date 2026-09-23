import type { Trip } from "../types";

/** 种子趟次：覆盖待发车、运输中退油/交付/修订、已到站三种形态 */
export function seedTrips(): Trip[] {
  const created = "2026-07-01T06:30:00.000Z";
  return [
    {
      id: "seed-trip-1",
      code: "PS20260701-01",
      plate: "鲁B·6093",
      departAt: "2026-07-02",
      status: "待发车",
      frozen: false,
      adjustUnlocked: false,
      currentStopIndex: 0,
      note: "等待装车复核",
      createdAt: created,
      loads: [
        { compartment: "1舱", product: "92号汽油", weight: 6 },
        { compartment: "2舱", product: "92号汽油", weight: 5 },
        { compartment: "3舱", product: "95号汽油", weight: 5 },
        { compartment: "4舱", product: "0号柴油", weight: 4 },
        { compartment: "5舱", product: "0号柴油", weight: 4 }
      ],
      stops: [
        { station: "城东站", order: 1, demands: { "92号汽油": 6, "0号柴油": 3 } },
        { station: "机场站", order: 2, demands: { "92号汽油": 5, "95号汽油": 5, "0号柴油": 5 } }
      ],
      deliveries: [],
      returns: [],
      revisions: []
    },
    {
      id: "seed-trip-2",
      code: "PS20260701-02",
      plate: "鲁B·7218",
      departAt: "2026-07-01",
      status: "运输中",
      frozen: true,
      adjustUnlocked: false,
      currentStopIndex: 1,
      note: "城东站已办理，前往机场站",
      createdAt: created,
      loads: [
        { compartment: "1舱", product: "92号汽油", weight: 6 },
        { compartment: "2舱", product: "92号汽油", weight: 5 },
        { compartment: "3舱", product: "95号汽油", weight: 4 },
        { compartment: "4舱", product: "95号汽油", weight: 4 },
        { compartment: "5舱", product: "0号柴油", weight: 5 },
        { compartment: "6舱", product: "0号柴油", weight: 3 },
        { compartment: "7舱", product: "92号汽油", weight: 3 }
      ],
      stops: [
        { station: "城东站", order: 1, demands: { "92号汽油": 8, "0号柴油": 2 } },
        { station: "机场站", order: 2, demands: { "92号汽油": 4, "95号汽油": 7 } },
        { station: "新区站", order: 3, demands: { "0号柴油": 6 } }
      ],
      deliveries: [
        {
          id: "seed-d-1",
          station: "城东站",
          compartment: "1舱",
          product: "92号汽油",
          weight: 6,
          at: "2026-07-01T09:10:00.000Z"
        },
        {
          id: "seed-d-2",
          station: "城东站",
          compartment: "2舱",
          product: "92号汽油",
          weight: 2,
          at: "2026-07-01T09:12:00.000Z"
        },
        {
          id: "seed-d-3",
          station: "城东站",
          compartment: "5舱",
          product: "0号柴油",
          weight: 2,
          at: "2026-07-01T09:15:00.000Z"
        }
      ],
      returns: [
        {
          id: "seed-r-1",
          station: "城东站",
          product: "92号汽油",
          requested: 4,
          allocated: 4,
          allocations: [
            { compartment: "1舱", product: "92号汽油", weight: 4 }
          ],
          overflow: 0,
          note: "站方清罐退回",
          at: "2026-07-01T09:40:00.000Z"
        },
        {
          id: "seed-r-2",
          station: "城东站",
          product: "95号汽油",
          requested: 1,
          allocated: 0,
          allocations: [],
          overflow: 1,
          note: "95号舱已满载，余量转待处理",
          at: "2026-07-01T09:45:00.000Z"
        }
      ],
      revisions: [
        {
          id: "seed-rev-1",
          at: "2026-07-01T08:20:00.000Z",
          reason: "过磅误差修正",
          changes: [
            {
              field: "载重",
              target: "7舱",
              product: "92号汽油",
              oldValue: "3",
              newValue: "3.2",
              diff: 0.2
            }
          ]
        }
      ]
    },
    {
      id: "seed-trip-3",
      code: "PS20260630-03",
      plate: "鲁B·8156",
      departAt: "2026-06-30",
      status: "已到站",
      frozen: true,
      adjustUnlocked: false,
      currentStopIndex: 1,
      note: "全程完成",
      createdAt: "2026-06-30T05:00:00.000Z",
      loads: [
        { compartment: "1舱", product: "0号柴油", weight: 6 },
        { compartment: "2舱", product: "0号柴油", weight: 5 },
        { compartment: "3舱", product: "92号汽油", weight: 5 },
        { compartment: "4舱", product: "95号汽油", weight: 4 }
      ],
      stops: [
        { station: "新区站", order: 1, demands: { "0号柴油": 11, "92号汽油": 5 } },
        { station: "港务站", order: 2, demands: { "95号汽油": 4 } }
      ],
      deliveries: [
        {
          id: "seed-d-4",
          station: "新区站",
          compartment: "1舱",
          product: "0号柴油",
          weight: 6,
          at: "2026-06-30T09:00:00.000Z"
        },
        {
          id: "seed-d-5",
          station: "新区站",
          compartment: "2舱",
          product: "0号柴油",
          weight: 5,
          at: "2026-06-30T09:05:00.000Z"
        },
        {
          id: "seed-d-6",
          station: "新区站",
          compartment: "3舱",
          product: "92号汽油",
          weight: 5,
          at: "2026-06-30T09:10:00.000Z"
        },
        {
          id: "seed-d-7",
          station: "港务站",
          compartment: "4舱",
          product: "95号汽油",
          weight: 4,
          at: "2026-06-30T11:00:00.000Z"
        }
      ],
      returns: [],
      revisions: []
    }
  ];
}
