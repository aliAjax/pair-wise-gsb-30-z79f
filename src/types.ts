/** 领域模型：罐车分舱装载与站间退油 */

export type Fuel = {
  code: string;
  name: string;
};

export type Compartment = {
  no: string; // 舱号
  capacity: number; // 额定载重（吨）
  fuelCode?: string; // 限定油品，留空表示通用舱
};

export type Vehicle = {
  plate: string; // 车牌
  model: string; // 车型
  compartments: Compartment[];
};

export type Station = {
  code: string;
  name: string;
};

export type LoadEntry = {
  id: string;
  compartmentNo: string;
  fuelCode: string;
  stationCode: string;
  order: number; // 到站顺序（1 起）
  tons: number;
  deliveredTons: number; // 已卸油量（到该站登记）
  /** 沿修订链继承自已作废旧行的已卸量（本版新增卸油为 deliveredTons，累计=两者之和） */
  carriedDeliveredTons?: number;
  supersedes?: string; // 本版替代的旧装载行 id（修订链）
  void?: boolean; // 重开调整后被废弃的计划行（保留修订痕迹）
};

export type ReturnAllocation = {
  compartmentNo: string; // 回装舱（原品空舱）
  tons: number;
};

export type ReturnRecord = {
  id: string;
  tripId: string;
  stationCode: string;
  order: number;
  fuelCode: string;
  tons: number; // 退油申报量
  allocated: ReturnAllocation[]; // 实际回装分配
  overflowTons: number; // 超出余量 → 待处理
  createdAt: string;
};

export type Revision = {
  id: string;
  tripId: string;
  field: string; // 如 舱位计划 / 到站顺序 / 车牌
  label: string; // 舱号 / 顺序
  oldValue: string;
  newValue: string;
  reason: string;
  createdAt: string;
};

export type PendingItem = {
  id: string;
  tripId: string;
  plate: string;
  stationCode: string;
  fuelCode: string;
  compartmentNo?: string;
  tons: number;
  /** 来源：退油超余量溢出 / 重开修订差额 */
  kind: "overflow" | "revision";
  reason: string;
  createdAt: string;
  resolved: boolean;
  resolveNote?: string;
  resolvedAt?: string;
};

export type TripStatus = "待发车" | "运输中" | "已到站" | "重开";

export type Trip = {
  id: string;
  plate: string;
  route: string[]; // 到站顺序（站点 code，按顺序）
  loads: LoadEntry[];
  returns: ReturnRecord[];
  revisions: Revision[];
  pending: PendingItem[];
  status: TripStatus;
  notes: string;
  createdAt: string;
  departAt?: string;
  reopenAt?: string;
  completeAt?: string;
};

export type Database = {
  vehicles: Vehicle[];
  stations: Station[];
  fuels: Fuel[];
  trips: Trip[];
};
