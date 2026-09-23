// 领域模型：罐车分舱配送 + 站间退油 + 冻结修订 + 冲突核对

export interface Product {
  code: string;
  name: string;
}

export interface Truck {
  plate: string; // 车牌
  name: string;
  compartments: CompartmentSpec[];
}

export interface CompartmentSpec {
  code: string; // 舱号
  capacity: number; // 核定载重（吨）
}

export interface Station {
  code: string;
  name: string;
}

export type TripStatus = "待发车" | "运输中" | "已到站";

/** 单舱装载登记：同一舱只允许登记同一油品 */
export interface CompartmentLoad {
  compartment: string; // 舱号
  product: string; // 油品
  weight: number; // 装载载重（吨）
}

/** 到站顺序中的一站，及该站各油品的计划卸油量 */
export interface StationStop {
  station: string;
  order: number;
  demands: Record<string, number>; // 油品 -> 需求吨数
}

/** 到站卸油交付明细 */
export interface Delivery {
  id: string;
  station: string;
  compartment: string;
  product: string;
  weight: number;
  at: string;
}

/** 退油入舱分配明细：只能回原品舱 */
export interface ReturnAllocation {
  compartment: string;
  product: string;
  weight: number;
}

/** 站方退油登记 */
export interface FuelReturn {
  id: string;
  station: string;
  product: string;
  requested: number; // 站方退回数量
  allocated: number; // 实际入舱数量
  allocations: ReturnAllocation[]; // 入舱分配
  overflow: number; // 入不下、转待处理的数量
  note: string;
  at: string;
}

/** 超余量退油转待处理的台账项 */
export interface PendingItem {
  id: string;
  tripId: string;
  tripCode: string;
  plate: string;
  station: string;
  product: string;
  weight: number;
  reason: string;
  createdAt: string;
  handled: boolean;
  handledNote: string;
  handledAt: string;
}

/** 发车后的冻结字段修订留痕 */
export interface Revision {
  id: string;
  at: string;
  reason: string;
  changes: RevisionChange[];
}

export type RevisionField =
  | "载重"
  | "油品"
  | "到站顺序"
  | "到站重开"
  | "行程重开";

export interface RevisionChange {
  field: RevisionField;
  target: string; // 舱号 / 站点 / 行程
  product?: string;
  oldValue: string;
  newValue: string;
  diff: number; // 差额（吨），非载重类为 0
}

/** 整趟核对时列出的冲突 */
export interface TripConflict {
  scope: "车牌" | "舱号" | "油品";
  target: string;
  product: string;
  expected: number; // 按登记/退油推算的应有在舱量
  actual: number; // 按交付/修订推算的实际在舱量
  diff: number; // 差额
}

export interface Trip {
  id: string;
  code: string; // 趟次号
  plate: string; // 车辆
  departAt: string; // 计划发车日期
  status: TripStatus;
  loads: CompartmentLoad[];
  stops: StationStop[];
  deliveries: Delivery[];
  returns: FuelReturn[];
  revisions: Revision[];
  currentStopIndex: number; // 正在停靠的站点下标
  frozen: boolean; // 发车后冻结
  adjustUnlocked: boolean; // 行程重开后允许调整舱位油品与到站顺序
  note: string;
  createdAt: string;
}

/** 装车登记表单行输入（允许同舱多行录入，提交时合并校验） */
export interface LoadDraft {
  compartment: string;
  product: string;
  weight: number;
}

export interface StopDraft {
  station: string;
  demands: Record<string, number>;
}

export interface ValidationIssue {
  message: string;
  compartment?: string;
  station?: string;
  product?: string;
}
