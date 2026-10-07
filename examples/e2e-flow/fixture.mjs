// Synthetic facts and human-reviewed read algebra. Expected values remain test-only;
// the business Agent receives records through the isolated connector, never from this module.
export const orderRecord = Object.freeze({
  id: 'ORD-E2E-001', system: 'OMS', objectType: 'E2ESalesOrder',
  tenantId: 'demo-enterprise', organizationId: 'org-market-dept',
  classification: 'internal', version: 'v1', occurredAt: '2026-10-01T10:00:00+08:00',
  payload: { order_id: 'ORD-E2E-001', customer_id: 'CUS-E2E-001', amount: 33000, status: 'delayed' },
  statement: '合成订单：ORD-E2E-001，金额 33000 CNY，状态 delayed。'
});

export const orderReadPlan = Object.freeze({
  id: 'e2e_order_read', label: '订单金额与延迟状态核验',
  datasets: [{ id: 'orders', objectType: 'E2ESalesOrder', where: [{ field: 'order_id', target: true }] }],
  outputs: [
    { id: 'orderAmountCny', label: '订单金额', unit: 'CNY', expression: { op: 'one', dataset: 'orders', field: 'amount' } },
    { id: 'isDelayed', label: '是否延迟', unit: '', expression: { op: 'eq', args: [{ op: 'one', dataset: 'orders', field: 'status' }, { op: 'literal', value: 'delayed' }] } }
  ]
});
