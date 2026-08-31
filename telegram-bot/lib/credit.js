// Nothing in the POS app's data model tracks whether a Credit-mode bill has since been paid
// back — there is no "settled" flag anywhere in the sales history. So "outstanding credit"
// is, by definition, every bill recorded with paymentMode === "Credit"; this module makes
// that explicit rather than silently guessing, and the report text says so plainly.

function computeOutstandingCredit(salesHistory) {
  const creditBills = (salesHistory || []).filter((b) => (b.paymentMode || '') === 'Credit');
  const total = creditBills.reduce((sum, b) => sum + (b.totalAmount || 0), 0);
  const byPatient = new Map();
  for (const bill of creditBills) {
    const key = bill.patientName || 'Unknown Patient';
    const prev = byPatient.get(key) || { patientName: key, billCount: 0, total: 0, bills: [] };
    prev.billCount += 1;
    prev.total += bill.totalAmount || 0;
    prev.bills.push({ billId: bill.billId, date: bill.date, amount: bill.totalAmount || 0 });
    byPatient.set(key, prev);
  }
  const patients = [...byPatient.values()].sort((a, b) => b.total - a.total);
  return { billCount: creditBills.length, total, patients };
}

module.exports = { computeOutstandingCredit };
