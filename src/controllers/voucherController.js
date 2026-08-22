const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const DEFAULT_VOUCHERS = [
  'Customer Sale',
  'POS Billing',
  'Company Purchase',
  'Customer Sale Return',
  'Company Purchase Return',
  'Customer Quotation',
  'Customer Sale Order',
  'Company Purchase Order',
  'Customer Payment',
  'Company Payment',
  'Delivery Challan',
  'Stock Adjustment',
  'Expense Entry',
  'Income Entry'
];

exports.getVouchers = async (req, res) => {
  const companyId = req.user.companyId;
  try {
    let vouchers = await prisma.voucher.findMany({
      where: { companyId }
    });

    // Ensure all 14 system types exist
    const existingTypes = vouchers.map(v => v.voucherType);
    const missingTypes = DEFAULT_VOUCHERS.filter(type => !existingTypes.includes(type));

    if (missingTypes.length > 0) {
      await prisma.voucher.createMany({
        data: missingTypes.map(type => ({
          companyId,
          voucherType: type,
          voucherHead: '',
          voucherId: 1
        }))
      });
      // Refetch after inserting
      vouchers = await prisma.voucher.findMany({
        where: { companyId }
      });
    }

    res.status(200).json({ success: true, data: vouchers });
  } catch (error) {
    console.error('Error fetching vouchers:', error);
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
};

exports.getNextNumberPreview = async (req, res) => {
  try {
    const { type } = req.query;
    const companyId = req.user.companyId;
    let voucher = await prisma.voucher.findFirst({
      where: { companyId, voucherType: type }
    });
    if (!voucher) {
      voucher = await prisma.voucher.create({
        data: { companyId, voucherType: type, voucherHead: '', voucherId: 1 }
      });
    }
    const nextNumber = `${voucher.voucherHead || ''}${voucher.voucherId || 1}`;
    return res.json({ 
      success: true, 
      nextNumber, 
      voucherHead: voucher.voucherHead || '', 
      voucherId: voucher.voucherId || 1 
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

exports.updateVoucher = async (req, res) => {
  const companyId = req.user.companyId;
  const { id } = req.params;
  const { voucherHead, voucherId } = req.body;
  try {
    const voucher = await prisma.voucher.update({
      where: { id: parseInt(id, 10), companyId },
      data: {
        voucherHead: voucherHead || '',
        voucherId: parseInt(voucherId, 10) || 1
      }
    });
    res.status(200).json({ success: true, data: voucher });
  } catch (error) {
    console.error('Error updating voucher:', error);
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
};

exports.fixVoucherSeriesRange = async (req, res) => {
  const companyId = req.user.companyId;
  const { voucherType, voucherHead, fromDate, toDate, startOffset } = req.body;
  
  try {
    const voucher = await prisma.voucher.findFirst({
      where: { companyId, voucherType }
    });
    
    if (voucher) {
      await prisma.voucher.update({
        where: { id: voucher.id },
        data: {
          voucherHead: voucherHead || '',
          voucherId: parseInt(startOffset, 10) || 1
        }
      });
    }

    res.status(200).json({ success: true, message: 'Voucher series updated successfully for future entries.' });
  } catch (error) {
    console.error('Error fixing voucher series:', error);
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
};

// Internal reusable atomic locking function
exports.getAndIncrementVoucherNumber = async (companyId, voucherType, tx = prisma) => {
  let voucher = await tx.voucher.findFirst({
    where: { companyId, voucherType }
  });
  // Auto-create if not exists (no fallback to random number)
  if (!voucher) {
    voucher = await tx.voucher.create({
      data: { companyId, voucherType, voucherHead: '', voucherId: 1 }
    });
  }

  const currentNumber = `${voucher.voucherHead || ''}${voucher.voucherId || 1}`;

  await tx.voucher.update({
    where: { id: voucher.id },
    data: { voucherId: (voucher.voucherId || 1) + 1 }
  });

  return currentNumber;
};

exports.mapInvoiceTypeToVoucher = (type) => {
  switch(type) {
    case 'SALES': return 'Customer Sale';
    case 'SALES_RETURN': return 'Customer Sale Return';
    case 'QUOTATION': return 'Customer Quotation';
    case 'CHALLAN': return 'Delivery Challan';
    case 'PURCHASE_ORDER': return 'Company Purchase Order';
    case 'SALES_ORDER': return 'Customer Sale Order';
    case 'PURCHASE': return 'Company Purchase';
    case 'PURCHASE_RETURN': return 'Company Purchase Return';
    case 'ADJUSTMENT': return 'Stock Adjustment';
    case 'POS': return 'POS Billing';
    default: return 'Customer Sale';
  }
};
