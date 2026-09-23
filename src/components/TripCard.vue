<script setup lang="ts">
/**
 * 页面层：单趟配送卡片
 * 展示车辆/舱位/油品/载重/到站顺序、退油回装、待处理、修订痕迹与重开冲突。
 */
import { computed, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useDeliveryStore } from "../stores/delivery";
import { deliveredOf, round2 } from "../domain/rules";
import type { Trip } from "../types";
import DeliveryDialog from "./DeliveryDialog.vue";
import ReturnDialog from "./ReturnDialog.vue";
import ReviseDialog from "./ReviseDialog.vue";

const props = defineProps<{ trip: Trip }>();
const store = useDeliveryStore();

const showDelivery = ref(false);
const showReturn = ref(false);
const showRevise = ref(false);

const vehicle = computed(() => store.getVehicle(props.trip.plate));

const loadRows = computed(() =>
  props.trip.loads.map((l) => ({
    ...l,
    delivered: deliveredOf(l),
    fuelName: store.fuelName(l.fuelCode),
    stationName: store.stationName(l.stationCode),
    remaining: round2(l.tons - deliveredOf(l))
  }))
);

const activeLoads = computed(() => loadRows.value.filter((l) => !l.void));

const conflicts = computed(() =>
  props.trip.status === "重开" ? store.conflictsOf(props.trip) : []
);

const statusType = computed<"" | "warning" | "success" | "info" | "danger">(() => {
  switch (props.trip.status) {
    case "待发车": return "info";
    case "运输中": return "";
    case "已到站": return "success";
    case "重开": return "warning";
    default: return "info";
  }
});

const totalTons = computed(() => round2(activeLoads.value.reduce((a, l) => a + l.tons, 0)));
const deliveredTons = computed(() => round2(activeLoads.value.reduce((a, l) => a + l.delivered, 0)));
const unresolvedPending = computed(() => props.trip.pending.filter((p) => !p.resolved));

function depart() {
  const r = store.depart(props.trip.id);
  if (!r.ok) {
    ElMessage.error(r.message);
    (r.conflicts ?? []).forEach((c) => ElMessage.warning(`${c.plate} ${c.compartmentNo} ${c.fuelName} 差额${c.diffTons}吨`));
  } else {
    ElMessage.success(r.message);
  }
}

async function complete() {
  const r = store.complete(props.trip.id);
  if (!r.ok) ElMessage.error(r.message);
  else ElMessage.success(r.message);
}

async function remove() {
  try {
    await ElMessageBox.confirm(`确认删除趟次 ${props.trip.plate}？该操作不可恢复。`, "删除确认", { type: "warning" });
    store.removeTrip(props.trip.id);
  } catch {
    /* 取消 */
  }
}

async function resolve(pendingId: string) {
  const { value } = await ElMessageBox.prompt("登记待处理项的处理说明", "结清待处理", {
    confirmButtonText: "结清",
    cancelButtonText: "取消",
    inputPlaceholder: "如：已转入备用罐 / 已由下趟回收"
  }).catch(() => ({ value: undefined }));
  if (value === undefined) return;
  const r = store.resolvePending(props.trip.id, pendingId, String(value ?? ""));
  if (r.ok) ElMessage.success(r.message);
}
</script>

<template>
  <article class="trip-card">
    <header class="trip-head">
      <div class="trip-title">
        <h3>{{ trip.plate }}</h3>
        <el-tag :type="statusType" effect="dark">{{ trip.status }}</el-tag>
        <span class="trip-model">{{ vehicle?.model }}</span>
      </div>
      <div class="trip-sum">
        <span>计划 <b>{{ totalTons }}</b> 吨</span>
        <span>已卸 <b>{{ deliveredTons }}</b> 吨</span>
        <span v-if="unresolvedPending.length" class="pending-badge">
          待处理 {{ unresolvedPending.length }} 项 / {{ round2(unresolvedPending.reduce((a, p) => a + p.tons, 0)) }} 吨
        </span>
      </div>
    </header>

    <!-- 到站顺序 -->
    <div class="route-line">
      <span class="block-label">到站顺序：</span>
      <template v-for="(code, i) in trip.route" :key="code">
        <span class="stop"><b>{{ i + 1 }}</b>{{ store.stationName(code) }}</span>
        <span v-if="i < trip.route.length - 1" class="arrow">→</span>
      </template>
    </div>

    <!-- 舱位装载 -->
    <el-table :data="loadRows" size="small" border class="inner-table">
      <el-table-column label="舱号" width="72">
        <template #default="{ row }">
          <el-tag v-if="row.void" type="danger" size="small" effect="plain">废</el-tag>
          {{ row.compartmentNo }}
        </template>
      </el-table-column>
      <el-table-column prop="fuelName" label="油品" width="110" />
      <el-table-column label="载重" width="82">
        <template #default="{ row }">{{ row.tons }}t</template>
      </el-table-column>
      <el-table-column label="到站" min-width="130">
        <template #default="{ row }">第{{ row.order }}站 · {{ row.stationName }}</template>
      </el-table-column>
      <el-table-column label="已卸" width="72">
        <template #default="{ row }">{{ row.delivered }}t</template>
      </el-table-column>
      <el-table-column label="舱容" width="92">
        <template #default="{ row }">
          <span v-if="vehicle">{{ vehicle.compartments.find((c) => c.no === row.compartmentNo)?.capacity ?? "—" }}t</span>
        </template>
      </el-table-column>
    </el-table>

    <!-- 退油记录 -->
    <section v-if="trip.returns.length" class="sub-block">
      <p class="block-label">站方退油</p>
      <div v-for="r in trip.returns" :key="r.id" class="ret-row">
        <span>第{{ r.order }}站 {{ store.stationName(r.stationCode) }}</span>
        <el-tag size="small">{{ store.fuelName(r.fuelCode) }}</el-tag>
        <span>申报 {{ r.tons }}t</span>
        <span class="alloc">
          回装：
          <template v-if="r.allocated.length">
            <el-tag v-for="a in r.allocated" :key="a.compartmentNo" size="small" type="success" effect="plain">
              {{ a.compartmentNo }} {{ a.tons }}t
            </el-tag>
          </template>
          <span v-else>—</span>
        </span>
        <el-tag v-if="r.overflowTons > 0" size="small" type="danger">溢出 {{ r.overflowTons }}t 转待处理</el-tag>
      </div>
    </section>

    <!-- 待处理 -->
    <section v-if="trip.pending.length" class="sub-block">
      <p class="block-label">待处理（超余量 / 修订差额）</p>
      <div v-for="p in trip.pending" :key="p.id" class="pend-row" :class="{ done: p.resolved }">
        <el-tag size="small" :type="p.resolved ? 'success' : 'danger'">{{ p.resolved ? "已结清" : "待处理" }}</el-tag>
        <span>{{ store.stationName(p.stationCode) }} · {{ store.fuelName(p.fuelCode) }} · {{ p.tons }}t</span>
        <span class="pend-reason">{{ p.reason }}</span>
        <el-button v-if="!p.resolved" size="small" link type="primary" @click="resolve(p.id)">登记结清</el-button>
        <span v-else class="resolve-note">{{ p.resolveNote }}</span>
      </div>
    </section>

    <!-- 修订痕迹 -->
    <section v-if="trip.revisions.length" class="sub-block">
      <p class="block-label">修订记录（冻结后调整留痕）</p>
      <el-timeline class="revise-timeline">
        <el-timeline-item
          v-for="rv in trip.revisions"
          :key="rv.id"
          :timestamp="new Date(rv.createdAt).toLocaleString('zh-CN')"
          placement="top"
          type="warning"
        >
          <div class="rv-line">
            <el-tag size="small" type="warning" effect="plain">{{ rv.field }} · {{ rv.label }}</el-tag>
            <span class="rv-old">{{ rv.oldValue }}</span>
            <span class="rv-arrow">→</span>
            <span class="rv-new">{{ rv.newValue }}</span>
          </div>
          <p class="rv-reason">原因：{{ rv.reason }}</p>
        </el-timeline-item>
      </el-timeline>
    </section>

    <!-- 重开冲突：车牌 / 舱号 / 油品 / 差额 -->
    <section v-if="conflicts.length" class="sub-block">
      <p class="block-label conflict-title">重开后核对冲突（{{ conflicts.length }}）</p>
      <el-table :data="conflicts" size="small" border>
        <el-table-column prop="plate" label="车牌" width="110" />
        <el-table-column prop="compartmentNo" label="舱号" width="70" />
        <el-table-column prop="fuelName" label="油品" width="110" />
        <el-table-column label="差额(吨)" width="90">
          <template #default="{ row }">
            <b :class="row.diffTons > 0 ? 'diff-plus' : 'diff-minus'">{{ row.diffTons > 0 ? "+" : "" }}{{ row.diffTons }}</b>
          </template>
        </el-table-column>
        <el-table-column prop="detail" label="说明" min-width="220" />
      </el-table>
    </section>

    <p class="trip-notes">{{ trip.notes }}</p>

    <footer class="trip-actions">
      <el-button v-if="trip.status === '待发车'" type="primary" size="small" @click="depart">发车（冻结舱位/顺序）</el-button>
      <el-button v-if="trip.status === '重开'" type="primary" size="small" @click="depart">核对后重新发车</el-button>
      <el-button v-if="trip.status === '运输中'" size="small" @click="showDelivery = true">到站卸油</el-button>
      <el-button v-if="trip.status === '运输中' || trip.status === '重开'" size="small" type="warning" plain @click="showReturn = true">站方退油</el-button>
      <el-button v-if="trip.status === '运输中'" size="small" type="success" plain @click="complete">完结到齐</el-button>
      <el-button v-if="trip.status !== '待发车'" size="small" type="warning" @click="showRevise = true">
        {{ trip.status === "重开" ? "继续修订" : "重开调整" }}
      </el-button>
      <el-button size="small" type="danger" link @click="remove">删除</el-button>
    </footer>

    <DeliveryDialog :trip="showDelivery ? trip : null" @close="showDelivery = false" />
    <ReturnDialog :trip="showReturn ? trip : null" @close="showReturn = false" />
    <ReviseDialog :trip="showRevise ? trip : null" @close="showRevise = false" />
  </article>
</template>
