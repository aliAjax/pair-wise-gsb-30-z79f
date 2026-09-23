<script setup lang="ts">
import { ref } from "vue";
import { useTripStore } from "../store/trips";
import { formatNumber } from "../logic/helpers";

const store = useTripStore();
const openId = ref("");
const handleNote = ref("");
const error = ref("");

function toggle(id: string) {
  openId.value = openId.value === id ? "" : id;
  handleNote.value = "";
  error.value = "";
}

function submit(id: string) {
  const result = store.handlePending(id, handleNote.value);
  if (!result.ok) {
    error.value = result.issues[0]?.message ?? "办结失败";
    return;
  }
  openId.value = "";
}

function fmtTime(value: string): string {
  return value ? value.replace("T", " ").slice(0, 16) : "";
}
</script>

<template>
  <section class="panel pending-panel">
    <div class="panel-title">
      <h2>退油待处理台账</h2>
      <span class="status" :class="store.pendings.filter((p) => !p.handled).length ? 'st-待发车' : ''">
        未办结 {{ store.pendings.filter((p) => !p.handled).length }} 笔
      </span>
    </div>
    <div v-if="store.pendings.length === 0" class="empty">暂无待处理退油</div>
    <ul class="pending-list">
      <li v-for="pending in store.pendings" :key="pending.id" :class="{ handled: pending.handled }">
        <div class="pending-main" @click="!pending.handled && toggle(pending.id)">
          <div>
            <strong>{{ pending.plate }} · {{ pending.tripCode }}</strong>
            <span class="pending-meta">{{ pending.station }} · {{ pending.product }}</span>
          </div>
          <div class="pending-right">
            <strong class="badge-warn">{{ formatNumber(pending.weight) }} 吨</strong>
            <span :class="['status', pending.handled ? '' : 'st-待发车']">
              {{ pending.handled ? "已办结" : "待处理" }}
            </span>
          </div>
        </div>
        <p class="pending-reason">{{ pending.reason }}（{{ fmtTime(pending.createdAt) }}）</p>
        <div v-if="openId === pending.id" class="inline-form" @click.stop>
          <label class="grow">处置说明
            <input v-model="handleNote" placeholder="如：已转罐入自有库存、安排空车回收" />
          </label>
          <div class="row">
            <button type="button" @click="submit(pending.id)">确认办结</button>
            <button type="button" class="secondary" @click="openId = ''">取消</button>
          </div>
          <p v-if="error" class="issue error">✕ {{ error }}</p>
        </div>
        <p v-if="pending.handled && pending.handledNote" class="handled-note">
          办结：{{ pending.handledNote }}（{{ fmtTime(pending.handledAt) }}）
        </p>
      </li>
    </ul>
  </section>
</template>
