<script setup lang="ts">
import { computed, ref } from "vue";
import PendingPanel from "./components/PendingPanel.vue";
import TripCard from "./components/TripCard.vue";
import TripForm from "./components/TripForm.vue";
import { useTripStore } from "./store/trips";
import { formatNumber, round3 } from "./logic/helpers";
import type { Trip } from "./types";

const stack = ["Vue3", "Vite", "TypeScript", "Pinia", "Element Plus"];
const statusFilters = ["全部状态", "待发车", "运输中", "已到站"] as const;
const stationFilters = ["全部油站", "城东站", "机场站", "新区站", "港务站"] as const;

const store = useTripStore();
const statusFilter = ref<(typeof statusFilters)[number]>("全部状态");
const stationFilter = ref<(typeof stationFilters)[number]>("全部油站");
const onlyConflict = ref(false);
const editing = ref<Trip | null>(null);
const showCreate = ref(true);

const filteredTrips = computed(() =>
  store.trips.filter((trip) => {
    if (statusFilter.value !== "全部状态" && trip.status !== statusFilter.value) return false;
    if (stationFilter.value !== "全部油站") {
      const hit =
        trip.stops.some((stop) => stop.station === stationFilter.value) ||
        trip.deliveries.some((item) => item.station === stationFilter.value) ||
        trip.returns.some((item) => item.station === stationFilter.value);
      if (!hit) return false;
    }
    if (onlyConflict.value && store.conflictsOf(trip.id).length === 0) return false;
    return true;
  })
);

const metrics = computed(() => {
  const trips = store.trips;
  const totalTons = round3(
    trips.reduce((sum, trip) => {
      const weight = trip.loads.reduce((inner, load) => inner + load.weight, 0);
      return sum + weight;
    }, 0)
  );
  const pendingTons = round3(
    store.pendings.filter((item) => !item.handled).reduce((sum, item) => sum + item.weight, 0)
  );
  const conflictCount = trips.reduce((sum, trip) => sum + store.conflictsOf(trip.id).length, 0);
  return [
    { label: "配送趟次", value: trips.length },
    { label: "在途/待发", value: trips.filter((t) => t.status !== "已到站").length },
    { label: "总装载吨数", value: formatNumber(totalTons) },
    { label: "待处理退油(吨)", value: formatNumber(pendingTons) },
    { label: "核对冲突", value: conflictCount }
  ];
});

const chartRows = computed(() =>
  (["待发车", "运输中", "已到站"] as const).map((status) => ({
    status,
    value: store.trips.filter((trip) => trip.status === status).length
  }))
);
const maxChart = computed(() => Math.max(1, ...chartRows.value.map((row) => row.value)));

function startEdit(trip: Trip) {
  editing.value = trip;
  showCreate.value = false;
}

function finishEdit() {
  editing.value = null;
}

function savedInCreate() {
  // 新建保存后保留表单，方便连续登记；有超余量警告时也保留
}
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">石油行业前端最小闭环</p>
          <h1>油品配送计划 · 罐车分舱与站间退油</h1>
          <p class="subtitle">
            每趟登记车辆、舱位、油品、载重与到站顺序；同舱同品、超量跨品整趟退回；
            退油只回原品空舱，超余量转待处理；发车冻结舱位顺序，调整留原因旧值；
            重开后配送、舱位、退油与修订仍对应，按车牌、舱号、油品核对差额。
          </p>
        </div>
        <div class="stack">
          <span v-for="item in stack" :key="item" class="tag">{{ item }}</span>
        </div>
      </header>

      <section class="metrics">
        <article v-for="metric in metrics" :key="metric.label" class="metric">
          <span>{{ metric.label }}</span>
          <strong :class="{ alarm: metric.label === '核对冲突' && Number(metric.value) > 0 }">
            {{ metric.value }}
          </strong>
        </article>
      </section>

      <section class="workspace wide-workspace">
        <div class="side">
          <TripForm
            v-if="!editing && showCreate"
            @saved="savedInCreate"
          />
          <TripForm
            v-else-if="editing"
            :trip="editing"
            @saved="finishEdit"
            @cancel="finishEdit"
          />
          <PendingPanel />
        </div>

        <section class="list-panel">
          <div class="toolbar">
            <h2>趟次列表</h2>
            <div class="filters">
              <select v-model="statusFilter">
                <option v-for="item in statusFilters" :key="item" :value="item">{{ item }}</option>
              </select>
              <select v-model="stationFilter">
                <option v-for="item in stationFilters" :key="item" :value="item">{{ item }}</option>
              </select>
              <label class="check">
                <input v-model="onlyConflict" type="checkbox" />
                只看有冲突
              </label>
            </div>
          </div>

          <div class="record-grid">
            <div v-if="filteredTrips.length === 0" class="empty">暂无匹配趟次</div>
            <TripCard
              v-for="trip in filteredTrips"
              :key="trip.id"
              :trip="trip"
              @edit="startEdit"
            />
          </div>

          <div class="mini-chart">
            <div v-for="row in chartRows" :key="row.status" class="bar">
              <span>{{ row.status }}</span>
              <div class="bar-track">
                <div class="bar-fill" :style="{ width: `${(row.value / maxChart) * 100}%` }" />
              </div>
              <strong>{{ row.value }}</strong>
            </div>
          </div>
        </section>
      </section>
    </div>
  </main>
</template>
