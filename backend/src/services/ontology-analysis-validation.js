// Conservative checks for observed financial evidence-denial/conflation patterns.
// This is not a general semantic truth classifier and never repairs prose by
// string replacement. A conflict makes the explanation incomplete.
export function inspectOntologyEvidenceClaims(text, records) {
  const banks = records.filter(r => r.objectType === 'BankReceipt');
  const allocations = records.filter(r => r.objectType === 'Allocation');
  const invoices = records.filter(r => r.objectType === 'Invoice');
  const orders = records.filter(r => r.objectType === 'SalesOrder');
  const linksToOrder = a => a.payload.bank_id != null
    && banks.some(b => b.system === a.system && b.payload.bank_id === a.payload.bank_id && b.payload.invoice_id != null
      && invoices.some(i => i.system === b.system && i.payload.invoice_id === b.payload.invoice_id && i.payload.order_id != null
        && orders.some(o => o.payload.order_id === i.payload.order_id)));
  const matchedAllocations = allocations.filter(a => a.payload.status === 'matched');
  const linkedMatch = matchedAllocations.some(linksToOrder);
  const allMatchedLinked = matchedAllocations.length > 0 && matchedAllocations.every(linksToOrder);
  const signals = [];
  const plain = text.replace(/[*`]/g, '');
  if (banks.length && /财务(?:侧|方面|数据|来源|证据)?[^。；;\n]{0,10}(?:仅有|只有|仅提供了?|只提供了?)[^。；;\n]{0,15}汇总/.test(plain)) {
    signals.push('financial_records_denied');
  }
  // A grouped unallocated metric really can be aggregate-only. Reject the
  // observed additional blanket denial of an existing bank/invoice/order
  // matching chain, not a request for finer line-level evidence or a pending
  // record's missing effective match.
  if (linkedMatch && plain.split(/[。；;\n]/).some(sentence =>
    /(?:仅有|只有)[^，,。]{0,12}汇总/.test(sentence)
    && /(?:缺少|缺乏|未提供)逐笔(?:银行流水|银行回单|到账|核销)[^。；;\n]{0,45}(?:匹配表|匹配关系|匹配记录)/.test(sentence)
    && !/订单行|发票行|费用项|行级|逐行/.test(sentence))) {
    signals.push('existing_match_chain_denied');
  }
  // A foreign-key join need not redundantly store invoice/order IDs on the
  // allocation itself. Cover this reproduced denial only when every matched
  // allocation has an available bank -> invoice -> order path.
  if (allMatchedLinked && plain.split(/[。；;\n]/).some(sentence =>
    /核销记录(?:仅|只)(?:直接)?关联\s*bank_id/.test(sentence)
    && /未提供逐笔到订单[/、和与]发票的完整匹配链路/.test(sentence)
    && !/订单行|发票行|费用项|行级|逐行/.test(sentence))) {
    signals.push('indirect_match_chain_denied');
  }
  // Narrow receipt/allocation conflation check, using source values rather
  // than fixture IDs or amounts. Skip unsafe/fractional arithmetic and an
  // ambiguous equal invoice gap; this is not a new accounting calculation.
  const integerAmount = value => Number.isSafeInteger(value) && value >= 0;
  for (const bank of banks) {
    if (bank.payload.status !== 'confirmed' || !integerAmount(bank.payload.amount)) continue;
    const matched = allocations.filter(a => a.system === bank.system && a.payload.bank_id === bank.payload.bank_id && a.payload.status === 'matched');
    if (!matched.length || matched.some(a => !integerAmount(a.payload.amount))) continue;
    const total = matched.reduce((sum, a) => sum + a.payload.amount, 0);
    const remainder = bank.payload.amount - total;
    if (!Number.isSafeInteger(total) || remainder <= 0) continue;
    const invoice = invoices.find(i => i.system === bank.system && i.payload.invoice_id === bank.payload.invoice_id);
    if (!invoice || !integerAmount(invoice.payload.amount) || invoice.payload.amount - bank.payload.amount === remainder) continue;
    if (plain.split(/[。；;\n]/).some(sentence => {
      const claim = sentence.match(/差额\s*([\d,]+)\s*(?:CNY|元)?[^。；;\n]{0,15}未见[^。；;\n]{0,8}到账/);
      return sentence.includes(bank.payload.bank_id) && /匹配|核销/.test(sentence) && claim && Number(claim[1].replaceAll(',', '')) === remainder;
    })) { signals.push('received_amount_described_as_missing'); break; }
  }
  return { passed: signals.length === 0, signals };
}
