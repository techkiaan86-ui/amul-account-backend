const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { getAndIncrementVoucherNumber } = require('./voucherController');

const mapInvoiceTypeToVoucher = (type) => {
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
    default: return 'Customer Sale';
  }
};

/**
 * Create an invoice for the tenant.
 * Expected payload:
 * {
 *   customerId: Number,
 *   date: String,
 *   paymentMode: String,
 *   remark: String,
 *   subTotal: Number,
 *   totalDiscount: Number,
 *   freightCharges: Number,
 *   totalAmount: Number,
 *   items: [ { productId: Number, quantity: Number, freeQty: Number, price: Number, discount1: Number, discount2: Number, imei: String, amount: Number } ]
 * }
 */
exports.createInvoice = async (req, res) => {
  const companyId = req.user.companyId;
  const { 
    customerId, date, paymentMode, remark, subTotal, 
    totalDiscount, freightCharges, totalAmount, 
    totalGstAmount, totalCgst, totalSgst, totalIgst,
    tcsAmount,
    items,
    salesperson,
    commission,
    type
  } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: 'Invoice must contain at least one item.' });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Check invoice limit based on subscription plan
      const companyWithPlan = await tx.company.findUnique({
        where: { id: companyId },
        include: { plan: true }
      });
      
      if (companyWithPlan && companyWithPlan.plan && companyWithPlan.plan.features) {
        let features = companyWithPlan.plan.features;
        if (typeof features === 'string') {
          try { features = JSON.parse(features); } catch(e){}
        }
        const invoiceLimit = features.invoiceLimit || features.invoices;
        if (invoiceLimit && String(invoiceLimit).toLowerCase() !== 'unlimited') {
          const currentInvoiceCount = await tx.invoice.count({ where: { companyId } });
          if (currentInvoiceCount >= parseInt(invoiceLimit, 10)) {
            throw new Error(`Invoice limit reached for your current plan (${invoiceLimit} invoices). Please upgrade your plan.`);
          }
        }
      }

      const customer = await tx.customer.findUnique({
        where: { id: parseInt(customerId, 10) },
        select: { id: true, companyId: true, name: true }
      });
      if (!customer || customer.companyId !== companyId) {
        throw new Error('Invalid customer for this company');
      }

      let earnedPoints = 0;
      const pointsToRedeem = parseInt(req.body.redeemedPoints, 10) || 0;

      for (const item of items) {
        const product = await tx.product.findUnique({
          where: { id: parseInt(item.productId, 10) },
          select: { id: true, stock: true, companyId: true, creditSalePrice: true }
        });
        if (!product || product.companyId !== companyId) {
          throw new Error(`Product ${item.productId} not found for this company`);
        }
        
        if (product.creditSalePrice && product.creditSalePrice > 0) {
          earnedPoints += Math.floor(product.creditSalePrice * (parseInt(item.quantity) || 0));
        }

        await tx.product.update({
          where: { id: product.id },
          data: { stock: { decrement: parseInt(item.quantity) } }
        });
      }

      if (customerId) {
        const netPoints = earnedPoints - pointsToRedeem;
        if (netPoints !== 0) {
          await tx.customer.update({
            where: { id: parseInt(customerId, 10) },
            data: { loyaltyPoints: { increment: netPoints } }
          });
        }
      }

      const invoice = await tx.invoice.create({
        data: {
          invoiceNo: req.body.invoiceNo || await getAndIncrementVoucherNumber(companyId, mapInvoiceTypeToVoucher(type || 'SALES'), tx),
          date: date ? new Date(date) : new Date(),
          subTotal: parseFloat(subTotal) || 0,
          totalDiscount: parseFloat(totalDiscount) || 0,
          freightCharges: parseFloat(freightCharges) || 0,
          totalAmount: parseFloat(totalAmount) || 0,
          totalGstAmount: parseFloat(totalGstAmount) || 0,
          totalCgst: parseFloat(totalCgst) || 0,
          totalSgst: parseFloat(totalSgst) || 0,
          totalIgst: parseFloat(totalIgst) || 0,
          tcsAmount: parseFloat(tcsAmount) || 0,
          paymentMode: paymentMode || 'Cash',
          salesperson: salesperson || null,
          commission: parseFloat(commission) || 0,
          remark: remark || '',
          companyId,
          customerId: parseInt(customerId, 10),
          items: {
            create: items.map(item => ({
              productId: parseInt(item.productId, 10),
              quantity: parseInt(item.quantity) || 0,
              freeQty: parseInt(item.freeQty) || 0,
              primaryOpeningQty: parseFloat(item.primaryOpeningQty) || 0,
              secOpeningQty: parseFloat(item.secOpeningQty) || 0,
              price: parseFloat(item.price) || 0,
              discount1: parseFloat(item.discount1) || 0,
              discount2: parseFloat(item.discount2) || 0,
              imei: item.imei || null,
              amount: parseFloat(item.amount) || 0,
              gstRate: parseFloat(item.gstRate) || 0,
              gstAmount: parseFloat(item.gstAmount) || 0,
              cgst: parseFloat(item.cgst) || 0,
              sgst: parseFloat(item.sgst) || 0,
              igst: parseFloat(item.igst) || 0
            }))
          }
        },
        include: {
          items: true
        }
      });

        // --- Auto-deposit Invoice Amount into Bank Ledger ---
        if (invoice.totalAmount > 0 && invoice.paymentMode && invoice.paymentMode.toLowerCase() !== 'credit') {
          const { updateBankBalance } = require('../services/bankService');
          const paymentDetails = req.body.paymentDetails || [];
          
          let processedAmount = 0;
          let paymentDetailsProvided = false;
          
          // Handle split payments if provided
          if (Array.isArray(paymentDetails) && paymentDetails.length > 0) {
            paymentDetailsProvided = true;
            for (const pd of paymentDetails) {
              const amt = parseFloat(pd.amount) || 0;
              const bId = parseInt(pd.bankId, 10);
              if (amt > 0) {
                let tType = 'IN';
                if (invoice.type === 'PURCHASE' || invoice.type === 'SALES_RETURN' || invoice.type === 'EXPENSE') tType = 'OUT';
                
                let targetBank = null;
                if (bId && bId !== 9999) {
                  targetBank = await tx.bank.findFirst({ where: { id: bId, companyId } });
                }
                if (!targetBank) {
                  targetBank = await tx.bank.findFirst({ 
                    where: { 
                      companyId, 
                      OR: [{ name: 'Cash' }, { type: 'Cash' }, { type: 'CASH BOOK' }] 
                    } 
                  }) || await tx.bank.findFirst({ where: { companyId } });
                }

                if (targetBank) {
                  await tx.bankTransaction.create({
                    data: {
                      date: invoice.date,
                      toBankId: tType === 'IN' ? targetBank.id : null,
                      fromBankId: tType === 'OUT' ? targetBank.id : null,
                      amount: amt,
                      remark: `${invoice.paymentMode || 'Payment'} ${invoice.type} - ${invoice.invoiceNo}`,
                      companyId
                    }
                  });
                  await tx.bank.update({
                    where: { id: targetBank.id },
                    data: { balance: { increment: tType === 'IN' ? amt : -amt } }
                  });
                  processedAmount += amt;
                }
              }
            }
          }
          
          // If no paymentDetails were provided, assume full payment in the primary paymentMode
          if (!paymentDetailsProvided) {
              let tType = 'IN';
              if (invoice.type === 'PURCHASE' || invoice.type === 'SALES_RETURN' || invoice.type === 'EXPENSE') tType = 'OUT';
              await updateBankBalance(companyId, invoice.paymentMode, invoice.totalAmount, tType, tx, `${invoice.paymentMode} ${invoice.type} - ${invoice.invoiceNo}`);
          }
        }
        // -------------------------------------------------------------

      // Audit Log for Create Invoice
      const partyName = customer ? (customer.name || 'Cash Sale') : 'Cash Sale';
      await tx.auditLog.create({
        data: {
          actionType: 'Create',
          moduleName: 'Sales Invoice',
          billNumber: invoice.invoiceNo,
          referenceId: String(invoice.id),
          userName: req.user.name || req.user.email || 'Unknown User',
          userRole: req.user.role || 'User',
          ipAddress: req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : (req.ip || req.socket.remoteAddress),
          details: JSON.stringify({
            documentNumber: invoice.invoiceNo,
            partyName: partyName,
            amount: Number(invoice.totalAmount || 0)
          }),
          companyId,
        },
      });

      return invoice;
    });

    res.status(201).json({ success: true, data: result });
  } catch (error) {
    console.error('Invoice creation error:', error);
    const message = error.message || 'Server error';
    res.status(400).json({ success: false, message });
  }
};

/**
 * Get all invoices or filter by type
 */
exports.getInvoices = async (req, res) => {
  const companyId = req.user.companyId;
  const { type } = req.query;

  try {
    const whereClause = { companyId, deletedAt: null };
    if (type) {
      whereClause.type = type;
    }

    const invoices = await prisma.invoice.findMany({
      where: whereClause,
      include: {
        customer: true,
        items: {
          include: {
            product: true
          }
        }
      },
      orderBy: {
        date: 'desc'
      }
    });

    res.status(200).json({ success: true, data: invoices });
  } catch (error) {
    console.error('Error fetching invoices:', error);
    res.status(400).json({ success: false, message: error.message || 'Server error' });
  }
};

/**
 * Mark an invoice as PAID
 */
exports.markInvoicePaid = async (req, res) => {
  const companyId = req.user.companyId;
  const { id } = req.params;

  try {
    const invoiceId = parseInt(id, 10);
    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId }
    });

    if (!invoice || invoice.companyId !== companyId) {
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }

    const updatedInvoice = await prisma.invoice.update({
      where: { id: invoiceId },
      data: { status: 'PAID' }
    });

    await prisma.auditLog.create({
      data: {
        actionType: 'Update',
        moduleName: 'Sales Invoice',
        billNumber: invoice.invoiceNo,
        referenceId: String(invoice.id),
        userName: String(req.user.name || req.user.email || req.user.id),
        userRole: req.user.role || 'User',
        ipAddress: req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : (req.ip || req.socket.remoteAddress),
        details: JSON.stringify({
          documentNumber: invoice.invoiceNo,
          amount: Number(invoice.totalAmount || 0),
          changes: 'Marked as PAID'
        }),
        companyId,
      },
    });

    res.status(200).json({ success: true, message: 'Invoice marked as paid', data: updatedInvoice });
  } catch (error) {
    console.error('Error marking invoice as paid:', error);
    res.status(400).json({ success: false, message: error.message || 'Server error' });
  }
};
