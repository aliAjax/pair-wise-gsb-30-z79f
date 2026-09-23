import type { Product, Station, Truck } from "../types";

/** 资料层：油品、罐车分舱、油站等基础主数据 */

export const PRODUCTS: Product[] = [
  { code: "P92", name: "92号汽油" },
  { code: "P95", name: "95号汽油" },
  { code: "P0", name: "0号柴油" }
];

export const TRUCKS: Truck[] = [
  {
    plate: "鲁B·7218",
    name: "7仓 30吨罐车",
    compartments: [
      { code: "1舱", capacity: 6 },
      { code: "2舱", capacity: 5 },
      { code: "3舱", capacity: 4 },
      { code: "4舱", capacity: 4 },
      { code: "5舱", capacity: 5 },
      { code: "6舱", capacity: 3 },
      { code: "7舱", capacity: 3 }
    ]
  },
  {
    plate: "鲁B·6093",
    name: "5仓 24吨罐车",
    compartments: [
      { code: "1舱", capacity: 6 },
      { code: "2舱", capacity: 5 },
      { code: "3舱", capacity: 5 },
      { code: "4舱", capacity: 4 },
      { code: "5舱", capacity: 4 }
    ]
  },
  {
    plate: "鲁B·8156",
    name: "4仓 20吨罐车",
    compartments: [
      { code: "1舱", capacity: 6 },
      { code: "2舱", capacity: 5 },
      { code: "3舱", capacity: 5 },
      { code: "4舱", capacity: 4 }
    ]
  }
];

export const STATIONS: Station[] = [
  { code: "S01", name: "城东站" },
  { code: "S02", name: "机场站" },
  { code: "S03", name: "新区站" },
  { code: "S04", name: "港务站" }
];

export function getTruck(plate: string): Truck | undefined {
  return TRUCKS.find((item) => item.plate === plate);
}

export function getCompartmentCapacity(plate: string, compartment: string): number {
  return getTruck(plate)?.compartments.find((item) => item.code === compartment)?.capacity ?? 0;
}

export function getStationName(code: string): string {
  return STATIONS.find((item) => item.code === code || item.name === code)?.name ?? code;
}

export function productName(code: string): string {
  return PRODUCTS.find((item) => item.code === code || item.name === code)?.name ?? code;
}

/** 需求/交付按油品登记用油品名（与原项目保持一致，避免另建映射） */
export const PRODUCT_NAMES = PRODUCTS.map((item) => item.name);
