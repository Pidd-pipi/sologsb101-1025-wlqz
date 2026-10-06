/**
 * v2 → v3 迁移测试：先用 v2 结构写入旧格式数据，再用当前 db.ts 打开触发真实 upgrade。
 */
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import Dexie from 'dexie';

globalThis.structuredClone = globalThis.structuredClone ?? ((value: unknown) => JSON.parse(JSON.stringify(value)));

async function seedV2() {
  const old = new Dexie('gbroastlog');
  old.version(2).stores({
    greenBeans: 'id, origin, process, arrivedAt, createdAt, updatedAt',
    roastProfiles: 'id, greenBeanId, machineModel, roastedAt, state, updatedAt',
    events: 'id, profileId, type, atSec, createdAt, updatedAt',
    cuppings: 'id, profileId, cuppedAt, totalScore, updatedAt',
    blends: 'id, name, state, createdAt, updatedAt',
    machineTemplates: 'id, model, chargeG, gasLevel',
  });
  await old.table('greenBeans').bulkPut([
    {
      id: 'gb-1', origin: '埃塞俄比亚 古吉', farm: '水洗站', process: 'washed', altitudeM: 2000,
      moisturePct: 10.8, stockKg: 5, arrivedAt: '2025-01-01', createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z',
    },
  ]);
  await old.table('roastProfiles').bulkPut([
    {
      id: 'rp-done', greenBeanId: 'gb-1', machineModel: 'HB-M6', chargeG: 500, chargeTempC: 200,
      airflow: 'half', gasLevel: 4, roastedAt: '2025-01-05', state: 'done',
      createdAt: '2025-01-05T00:00:00.000Z', updatedAt: '2025-01-05T00:00:00.000Z',
    },
    {
      id: 'rp-void', greenBeanId: 'gb-1', machineModel: 'HB-M6', chargeG: 400, chargeTempC: 200,
      airflow: 'half', gasLevel: 4, roastedAt: '2025-01-06', state: 'void',
      createdAt: '2025-01-06T00:00:00.000Z', updatedAt: '2025-01-06T00:00:00.000Z',
    },
  ]);
  await old.table('cuppings').bulkPut([
    {
      id: 'cp-1', profileId: 'rp-done', cuppedAt: '2025-01-07',
      dryAroma: 8.5, wetAroma: 8.5, acidity: 8.5, sweetness: 8.5, aftertaste: 8.5, totalScore: 85,
      createdAt: '2025-01-07T00:00:00.000Z', updatedAt: '2025-01-07T00:00:00.000Z',
    },
  ]);
  // 旧方案：无 targetBatchKg；成分 rp-gone 已不存在（待补认，认不出停待核销）
  await old.table('blends').bulkPut([
    {
      id: 'bl-old', name: '旧方案', state: 'trial', targetFlavor: '花香',
      items: [{ greenBeanId: 'gb-1', profileId: 'rp-gone', ratioPct: 100 }],
      createdAt: '2025-01-08', updatedAt: '2025-01-08T00:00:00.000Z',
    },
  ]);
  await old.table('machineTemplates').bulkPut([
    {
      id: 'mt-1', model: 'HB-M6', airflow: 'half', gasLevel: 4, chargeG: 500, note: '旧模板',
      createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z',
    },
  ]);
  await old.close();
}

async function main() {
  await seedV2();

  const dbModule = await import('../src/utils/db.ts');
  await dbModule.initDatabase(); // 触发 v2 → v3 upgrade

  const profiles = await dbModule.listRoastProfiles();
  const done = profiles.find((p) => p.id === 'rp-done')!;
  assert.equal(done.scheduleStatus, 'scheduled', '旧烘焙记录迁移后默认已排产');
  assert.equal(done.queueOrder, 0);

  const templates = await dbModule.db.machineTemplates.toArray();
  assert.equal(templates[0].dailyCapacityG, null, '旧模板迁移后当天容量为 null（不限量）');

  const blends = await dbModule.listBlends();
  const oldBlend = blends.find((b) => b.id === 'bl-old')!;
  assert.equal(oldBlend.targetBatchKg, 1, '旧方案迁移后默认目标批量 1kg');
  assert.equal(oldBlend.pendingReplace, true, '认不出锅次的旧试配方案应停在待替换（待核销）');

  const pots = await dbModule.listRoastPots();
  const donePot = pots.find((p) => p.profileId === 'rp-done')!;
  const voidPot = pots.find((p) => p.profileId === 'rp-void')!;
  assert.equal(donePot.status, 'pending', '已完成旧锅迁移后为待核销');
  assert.equal(donePot.lastScore, 85, '杯测分应带到锅次台账');
  assert.equal(voidPot.status, 'void', '作废旧锅迁移后为已报废');

  // 旧锅补登记核销后占用可生效
  const verify = await dbModule.verifyRoastPot('rp-done', { productKg: 0.42, sampleKg: 0.02, lossKg: 0.06 });
  assert.equal(verify.ok, true, verify.message);
  // 成分仍指向不存在的 rp-gone → 依旧待替换
  const blends2 = await dbModule.listBlends();
  assert.equal(blends2.find((b) => b.id === 'bl-old')!.pendingReplace, true);

  console.log('v2 → v3 迁移断言通过 ✅');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
