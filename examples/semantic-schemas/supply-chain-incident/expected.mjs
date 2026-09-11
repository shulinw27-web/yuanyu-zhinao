// Independent human audit baseline, NEVER sent to either model.
export const expected = {
  impactedBatches: ['PB-N1', 'PB-N2'], directLots: ['LOT-N1', 'LOT-N2', 'LOT-N3'],
  transitiveLots: ['LOT-N1', 'LOT-N2', 'LOT-N3', 'LOT-N4', 'LOT-N5'],
  unaffectedRaw: ['RAW-N2'], excludedPlanned: ['PB-N3'], notBackwardImpacted: ['LOT-N9'],
  stores: ['SHOP-N1', 'SHOP-N2', 'SHOP-N3'], orders: ['SO-N1', 'SO-N2', 'SO-N3'],
  totals: { warehousePieces: 460, transitPieces: 60, storePieces: 190, soldPieces: 290, pendingReturnPieces: 10,
    involvedOrderCny: 6000, confirmedBankCny: 5000, matchedCny: 2500, unallocatedCny: 2500 },
  // Intentional bounded-plan partial baseline, NOT the full-world answer.
  directOnly: { warehousePieces: 340, transitPieces: 40, storePieces: 130, soldPieces: 190, pendingReturnPieces: 10,
    involvedOrderCny: 4000, confirmedBankCny: 3000, matchedCny: 2500, unallocatedCny: 500 },
  contacts: ['PER-N1', 'PER-N2', 'PER-N3'], excludedContact: 'PER-N0', rootCause: 'unconfirmed', actionExecuted: false
};
