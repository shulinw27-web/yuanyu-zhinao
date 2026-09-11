// Narrow regression checks for the observed wording fault, NOT a production
// truth classifier. Passing these checks still requires reading the answer.
export function checkEvidenceRegression(answer, caseId) {
  const text = answer || '';
  const checks = {
    hasAnswer: Boolean(answer),
    noOnlyAggregateClaim: !/财务(?:侧|方面|数据|来源|证据)?[^。；;\n]{0,10}(?:仅有|只有|仅提供了?|只提供了?|仅包含)[^。；;\n]{0,20}汇总/.test(text)
  };
  if (caseId === 'cause') {
    checks.causeAndPeople = ['LAB-N1', 'QE-N1', 'PER-N1', 'PER-N2', 'PER-N3'].every(id => text.includes(id));
    checks.causeUnconfirmed = /未确认|尚未|不能|未证实|root.cause.unconfirmed|retest.pending/.test(text);
  } else {
    checks.bankDetailIds = ['BANK-N1', 'BANK-N2', 'BANK-N3'].every(id => text.includes(id));
    if (caseId === 'finance') {
      checks.allocationDetailIds = ['ALLOC-N1', 'ALLOC-N2', 'ALLOC-N3'].every(id => text.includes(id));
      checks.pendingNotClosed = /pending|待核销|待匹配|未核销|待处理/.test(text);
      // Exact observed conflation: 500 is already received but not allocated,
      // whereas the order-to-bank difference is 600 in this synthetic fixture.
      checks.noObservedReceiptConflation = !/差额\s*500\s*(?:CNY|元)?[^。；;\n]{0,15}未见[^。；;\n]{0,8}到账/.test(text);
    } else if (caseId === 'no-allocation') {
      checks.noInventedAllocationIds = !/ALLOC-N\d/.test(text);
      checks.scopedAbsence = /未(?:查|检索|读取|提供|得到)|无.{0,12}核销|核销.{0,12}(?:记录为\s*0|记录数为\s*0|为空|缺失)/.test(text);
    }
  }
  return { checks, passed: Object.values(checks).every(Boolean) };
}
