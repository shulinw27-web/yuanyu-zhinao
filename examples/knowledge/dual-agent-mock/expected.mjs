// Evaluator oracle only: never attach this file or pass these totals to either Agent.
export const expected = {
  orderAmountCny: 12000, demandPieces: 230, southOwnedAvailablePieces: 75, shortagePieces: 155,
  bankConfirmedUnallocated: 9000, credit: 8500, creditGap: 3500,
  consignmentTransferExecuted: false, returnReleased: false
};
// Independent arithmetic: 23*10; 9*10-15; 230-75; 14000-5000;
// 62000-47000-6500; 12000-8500. A draft B would give 13000, not the active 8500.

// Independent review cases. These records and expected values are supplied only
// to the deterministic replay endpoint, never to the proposal-generating model.
export function complexReplayCases(planId, records) {
  const base = { planId, target: 'ORD-T900' };
  const mutate = (id, patch) => structuredClone(records).map(row => row.id === id ? { ...row, payload: { ...row.payload, ...patch } } : row);
  const cases = [
    { label: 'baseline', records, expected },
    { label: 'higher_order_amount', records: mutate('ORD-T900', { amount: 20000 }), expected: { ...expected, orderAmountCny: 20000, creditGap: 11500 } },
    { label: 'empty_owned_stock', records: mutate('ST-T1', { qty: 0 }), expected: { ...expected, southOwnedAvailablePieces: 0, shortagePieces: 230 } },
    { label: 'cancelled_demand', records: mutate('LINE-T1', { status: 'cancelled' }), expected: { ...expected, demandPieces: 0, southOwnedAvailablePieces: 0, shortagePieces: 0 } },
    { label: 'piece_not_case', records: mutate('LINE-T1', { unit: 'piece' }), expected: { ...expected, demandPieces: 23, shortagePieces: 0 } },
    { label: 'batch_quarantined', records: mutate('LOT-T1', { quality_status: 'quarantined' }), expected: { ...expected, southOwnedAvailablePieces: 0, shortagePieces: 230 } },
    { label: 'other_order_reservation', records: mutate('RS-T1', { qty: 100 }), expected: { ...expected, southOwnedAvailablePieces: 0, shortagePieces: 230 } },
    { label: 'execution_evidence_exists', records: mutate('AP-T1', { execution_receipt_id: 'SYNTHETIC-RECEIPT' }), expected: { ...expected, consignmentTransferExecuted: true } },
    { label: 'inspection_passed', records: mutate('RI-T1', { result: 'passed' }), expected: { ...expected, returnReleased: true } },
    { label: 'unconfirmed_receipt', records: mutate('CR-T1', { bank_status: 'pending' }), expected: { ...expected, bankConfirmedUnallocated: 0 } },
    { label: 'unmatched_allocation', records: mutate('CA-T1', { status: 'pending' }), expected: { ...expected, bankConfirmedUnallocated: 14000 } },
    { label: 'own_order_reservation', records: mutate('RS-T1', { order_id: 'ORD-T900' }), expected: { ...expected, southOwnedAvailablePieces: 90, shortagePieces: 140 } },
    { label: 'reservation_in_cases', records: mutate('RS-T1', { unit: 'case' }), expected: { ...expected, southOwnedAvailablePieces: 0, shortagePieces: 230 } },
    { label: 'wrong_warehouse', records: mutate('ST-T1', { warehouse_id: 'WH-NORTH-01' }), expected: { ...expected, southOwnedAvailablePieces: 0, shortagePieces: 230 } },
    { label: 'unknown_unit', records: mutate('LINE-T1', { unit: 'pallet' }), expectedError: 'READ_PRECONDITION_FAILED' },
    { label: 'missing_root', records: [], expectedError: 'READ_ROOT_NOT_FOUND' }
  ];
  return cases.map(c => ({ ...base, ...c }));
}
