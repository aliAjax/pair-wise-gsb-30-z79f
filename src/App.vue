<script setup lang="ts">
/**
 * 页面层入口：顶部指标 + 趟次登记 + 趟次列表（筛选）。
 * 资料见 src/data，判定见 src/domain，存储见 src/stores。
 */
import { computed, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useDeliveryStore } from "./stores/delivery";
import { round2 } from "./domain/rules";
import TripForm from "./components/TripForm.vue";
import TripCard from "./components/TripCard.vue";

const store = useDeliveryStore();

const statusFilter = ref<"全部" | "待发车" | "运输中" | "已到站" | "重开">("全部");
const stationFilter = ref<string>("ALL");
const onlyConflict = ref(false);

const metrics = computed(() => {
  const trips = store.trips;
  const total = trips.length;
  const inTransit = trips.filter((t) => t.status === "运输中").length;
  const totalTons = round2(
    trips
      .flatMap((t) => t.loads.filter((l) => !l.void))
      .reduce((a, l) => a + l.tons, 0)
  );
  const pendingTons = round2(
    trips.flatMap((t) => t.pending.filter((p) => !p.resolved)).reduce((a, p) => a + p.tons, 0)
  );
  const reopenCount = trips.filter((t) => t.status === "重开").length;
  return { total, inTransit, totalTons, pendingTons, reopenCount };
});

const statusChart = computed(() =>
  (["待发车", "运输中", "已到站", "重开"] as const).map((s) => ({
    status: s,
    value: store.trips.filter((t) => t.status === s).length
  }))
);
const maxChart = computed(() => Math.max(1, ...statusChart.value.map((r) => r.value)));

const filteredTrips = computed(() =>
  store.trips.filter((t) => {
    if (statusFilter.value !== "全部" && t.status !== statusFilter.value) return false;
    if (stationFilter.value !== "ALL") {
      const hit =
        t.route.includes(stationFilter.value) ||
        t.loads.some((l) => l.stationCode === stationFilter.value) ||
        t.returns.some((r) => r.stationCode === stationFilter.value);
      if (!hit) return false;
    }
    if (onlyConflict.value) {
      if (t.status !== "重开" || store.conflictsOf(t).length === 0) return false;
    }
    return true;
  })
);

async function resetAll() {
  try {
    await ElMessageBox.confirm("将清空本地数据并恢复演示数据，确认继续？", "重置数据", { type: "warning" });
    store.resetAll();
    ElMessage.success("已恢复演示数据");
  } catch {
    /* 取消 */
  }
}
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">石油行业 · 罐车分舱配送</p>
          <h1>油品配送计划</h1>
          <p class="subtitle">
            每趟登记车辆、舱位、油品、载重与到站顺序；同舱同品、超量跨品整趟退回；
            站方退油只回原品空舱、溢出转待处理、不压占后续站点；发车冻结，重开留痕并核对差额。
          </p>
        </div>
        <div class="stack">
          <span v-for="item in ['Vue3', 'Vite', 'TypeScript', 'Pinia', 'Element Plus']" :key="item" class="tag">
            {{ item }}
          </span>
        </div>
      </header>

      <section class="metrics">
        <article class="metric">
          <span>配送趟次</span>
          <strong>{{ metrics.total }}</strong>
        </article>
        <article class="metric">
          <span>运输中</span>
          <strong>{{ metrics.inTransit }}</strong>
        </article>
        <article class="metric">
          <span>在途总载重（吨）</span>
          <strong>{{ metrics.totalTons }}</strong>
        </article>
        <article class="metric" :class="{ alert: metrics.pendingTons > 0 }">
          <span>待处理油品（吨）</span>
          <strong>{{ metrics.pendingTons }}</strong>
        </article>
        <article class="metric" :class="{ alert: metrics.reopenCount > 0 }">
          <span>重开待复核</span>
          <strong>{{ metrics.reopenCount }}</strong>
        </article>
      </section>

      <section class="workspace">
        <TripForm />

        <section class="list-panel">
          <div class="toolbar">
            <h2>趟次列表</h2>
            <div class="filters">
              <el-select v-model="statusFilter" size="small" style="width: 120px">
                <el-option label="全部状态" value="全部" />
                <el-option v-for="s in ['待发车', '运输中', '已到站', '重开']" :key="s" :label="s" :value="s" />
              </el-select>
              <el-select v-model="stationFilter" size="small" style="width: 130px">
                <el-option label="全部油站" value="ALL" />
                <el-option v-for="s in store.stations" :key="s.code" :label="s.name" :value="s.code" />
              </el-select>
              <el-checkbox v-model="onlyConflict">只看重开冲突</el-checkbox>
              <el-button size="small" @click="resetAll">重置演示数据</el-button>
            </div>
          </div>

          <div class="mini-chart">
            <div v-for="row in statusChart" :key="row.status" class="bar">
              <span>{{ row.status }}</span>
              <div class="bar-track">
                <div class="bar-fill" :style="{ width: `${(row.value / maxChart) * 100}%` }" />
              </div>
              <strong>{{ row.value }}</strong>
            </div>
          </div>

          <div class="trip-grid">
            <div v-if="filteredTrips.length === 0" class="empty">暂无匹配趟次</div>
            <TripCard v-for="trip in filteredTrips" :key="trip.id" :trip="trip" />
          </div>
        </section>
      </section>
    </div>
  </main>
</template>
