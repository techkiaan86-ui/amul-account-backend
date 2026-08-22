const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { updateStock } = require('../services/inventoryService');
const { getAndIncrementVoucherNumber, mapInvoiceTypeToVoucher } = require('./voucherController');

/**
 * Validates transaction type against allowed enum values
 */
const isValidTransactionType = (type) => {
  const validTypes = [
    'PURCHASE_ORDER', 'PURCHASE', 'PURCHASE_RETURN', 
    'SALES', 'SALES_RETURN', 'CHALLAN', 
    'STOCK_TRANSFER', 'QUOTATION', 'ADJUSTMENT'
  ];
  return validTypes.includes(type.toUpperCase());
};

// Create a new inventory transaction
exports.createTransaction = async (req, res) => {
  const { type } = req.params;
  const { 
    date, subTotal, totalDiscount, freightCharges, 
    totalAmount, paymentMode, remark, status, customerId, 
    warehouseId, toWarehouseId, tcsAmount,
    totalGstAmount, totalCgst, totalSgst, totalIgst, items 
  } = req.body;
  const companyId = req.user.companyId;

  // invoiceNo will be generated atomically inside the transaction

  if (!isValidTransactionType(type)) {
    return res.status(400).json({ error: "Invalid transaction type" });
  }

  if (!items || !items.length) {
    return res.status(400).json({ error: "Items array is required" });
  }

  try {
    // We use a transaction to ensure both invoice creation and stock updates happen atomically
    const result = await prisma.$transaction(async (tx) => {
      const generatedInvoiceNo = req.body.invoiceNo || await getAndIncrementVoucherNumber(companyId, mapInvoiceTypeToVoucher(type.toUpperCase()), tx);
      // 1. Create the Transaction (Invoice)
      const invoice = await tx.invoice.create({
        data: {
          invoiceNo: generatedInvoiceNo,
          date: date ? new Date(date) : new Date(),
          type: type.toUpperCase(),
          subTotal,
          totalDiscount,
          freightCharges,
          totalAmount,
          totalGstAmount: totalGstAmount ? parseFloat(totalGstAmount) : 0,
          totalCgst: totalCgst ? parseFloat(totalCgst) : 0,
          totalSgst: totalSgst ? parseFloat(totalSgst) : 0,
          totalIgst: totalIgst ? parseFloat(totalIgst) : 0,
          tcsAmount: tcsAmount ? parseFloat(tcsAmount) : 0,
          paymentMode,
          remark,
          status,
          companyId,
          customerId: customerId ? parseInt(customerId, 10) : undefined,
          warehouseId: warehouseId ? parseInt(warehouseId, 10) : undefined,
          toWarehouseId: toWarehouseId ? parseInt(toWarehouseId, 10) : undefined,
          items: {
            create: items.map(item => ({
              productId: item.productId,
              quantity: item.quantity,
              freeQty: item.freeQty,
              primaryOpeningQty: item.primaryOpeningQty,
              secOpeningQty: item.secOpeningQty,
              price: item.price,
              discount1: item.discount1,
              discount2: item.discount2,
              batchNo: item.batchNo,
              description: item.description,
              mfgDate: item.mfgDate,
              expDate: item.expDate,
              amount: item.amount,
              imei: item.imei,
              ram: item.ram,
              storage: item.storage,
              color: item.color,
              gstRate: item.gstRate ? parseFloat(item.gstRate) : 0,
              gstAmount: item.gstAmount ? parseFloat(item.gstAmount) : 0,
              cgst: item.cgst ? parseFloat(item.cgst) : 0,
              sgst: item.sgst ? parseFloat(item.sgst) : 0,
              igst: item.igst ? parseFloat(item.igst) : 0
            }))
          }
        },
        include: { items: true }
      });

      // 2. Update stock depending on transaction type
      await updateStock(items, type.toUpperCase(), warehouseId, toWarehouseId, tx);

      // 3. Calculate total paid amount from paymentDetails or paymentMode
      let totalPaid = 0;
      if (Array.isArray(req.body.paymentDetails) && req.body.paymentDetails.length > 0) {
        totalPaid = req.body.paymentDetails.reduce((sum, pd) => sum + (parseFloat(pd.amount) || 0), 0);
      } else if (req.body.paymentMode && req.body.paymentMode.toLowerCase() !== 'credit' && status === 'PAID') {
        totalPaid = parseFloat(totalAmount) || 0;
      }

      const dueAmountToAdd = Math.max(0, (parseFloat(totalAmount) || 0) - totalPaid);

      // 4. Update financial ledgers (Customer/Party balance)
      const parsedCustomerId = customerId ? parseInt(customerId, 10) : null;
      if (parsedCustomerId && !isNaN(parsedCustomerId)) {
        if (type.toUpperCase() === 'SALES') {
          // Increase customer balance ONLY by remaining unpaid due amount
          if (dueAmountToAdd > 0) {
            await tx.customer.update({
              where: { id: parsedCustomerId },
              data: { balance: { increment: dueAmountToAdd } }
            });
          }
        } else if (type.toUpperCase() === 'PURCHASE') {
          // Increase supplier balance ONLY by remaining unpaid due amount
          if (dueAmountToAdd > 0) {
            await tx.customer.update({
              where: { id: parsedCustomerId },
              data: { balance: { increment: dueAmountToAdd } }
            });
          }
        } else if (type.toUpperCase() === 'SALES_RETURN') {
          await tx.customer.update({
            where: { id: parsedCustomerId },
            data: { balance: { decrement: (parseFloat(totalAmount) || 0) - totalPaid } }
          });
        } else if (type.toUpperCase() === 'PURCHASE_RETURN') {
          await tx.customer.update({
            where: { id: parsedCustomerId },
            data: { balance: { decrement: (parseFloat(totalAmount) || 0) - totalPaid } }
          });
        }
      }

      // 5. Update Loyalty Points
      if (parsedCustomerId && !isNaN(parsedCustomerId) && (type.toUpperCase() === 'SALES' || type.toUpperCase() === 'PURCHASE')) {
        let earnedPoints = 0;
        for (const item of items) {
          const product = await tx.product.findUnique({
            where: { id: parseInt(item.productId, 10) },
            select: { creditSalePrice: true }
          });
          if (product && product.creditSalePrice > 0) {
            earnedPoints += Math.floor(product.creditSalePrice * (parseInt(item.quantity) || 0));
          }
        }
        const pointsToRedeem = parseInt(req.body.redeemedPoints, 10) || 0;
        const netPoints = earnedPoints - pointsToRedeem;
        if (netPoints !== 0) {
          await tx.customer.update({
            where: { id: parsedCustomerId },
            data: { loyaltyPoints: { increment: netPoints } }
          });
        }
      }

      // 6. Update Bank Balances from paymentDetails
      if (Array.isArray(req.body.paymentDetails) && req.body.paymentDetails.length > 0) {
        for (const pd of req.body.paymentDetails) {
          const amt = parseFloat(pd.amount) || 0;
          if (amt > 0) {
            const bId = parseInt(pd.bankId, 10);
            let targetBank = null;
            if (bId && bId !== 9999) {
              targetBank = await tx.bank.findFirst({ where: { id: bId, companyId } });
            }
            if (!targetBank) {
              targetBank = await tx.bank.findFirst({
                where: {
                  companyId,
                  OR: [
                    { name: 'Cash' },
                    { type: 'Cash' },
                    { type: 'CASH BOOK' },
                    { type: 'WALLET-BOOK' }
                  ]
                }
              }) || await tx.bank.findFirst({ where: { companyId } });
            }

            if (targetBank) {
              let isOutflow = false;
              if (['PURCHASE', 'SALES_RETURN', 'PURCHASE_ORDER'].includes(type.toUpperCase())) {
                isOutflow = true; // Money goes out of our bank
              } else if (['SALES', 'PURCHASE_RETURN', 'SALES_ORDER', 'QUOTATION'].includes(type.toUpperCase())) {
                isOutflow = false; // Money comes into our bank
              }

              await tx.bankTransaction.create({
                data: {
                  date: new Date(),
                  fromBankId: isOutflow ? targetBank.id : null,
                  toBankId: isOutflow ? null : targetBank.id,
                  amount: amt,
                  remark: `${type.toUpperCase()} ${isOutflow ? 'Payment' : 'Receipt'} - ${invoice.invoiceNo}`,
                  companyId
                }
              });
              await tx.bank.update({
                where: { id: targetBank.id },
                data: { balance: { increment: isOutflow ? -amt : amt } }
              });
            }
          }
        }
      } else if (req.body.paymentMode && req.body.paymentMode.toLowerCase() !== 'credit' && status === 'PAID' && (parseFloat(totalAmount) || 0) > 0) {
         const { updateBankBalance } = require('../services/bankService');
         let tType = ['PURCHASE', 'SALES_RETURN', 'PURCHASE_ORDER'].includes(type.toUpperCase()) ? 'OUT' : 'IN';
         await updateBankBalance(companyId, req.body.paymentMode, parseFloat(totalAmount) || 0, tType, tx, `${type.toUpperCase()} ${tType === 'OUT' ? 'Payment' : 'Receipt'} - ${invoice.invoiceNo}`);
      }

      return invoice;
    });

    res.status(201).json({ message: "Transaction created successfully", data: result });
  } catch (error) {
    console.error("Inventory creation error:", error);
    res.status(500).json({ error: error.message || "Failed to create transaction" });
  }
};

// Get all transactions of a specific type
exports.getTransactions = async (req, res) => {
  const { type } = req.params;
  const { startDate, endDate, customerId } = req.query;
  const companyId = req.user.companyId;

  if (!isValidTransactionType(type)) {
    return res.status(400).json({ error: "Invalid transaction type" });
  }

  try {
    const whereClause = { 
      companyId,
      type: type.toUpperCase(),
      deletedAt: null
    };

    if (startDate && endDate) {
      const start = new Date(startDate);
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      whereClause.date = {
        gte: start,
        lte: end
      };
    }

    if (customerId && customerId !== 'all') {
      whereClause.customerId = parseInt(customerId, 10);
    }

    const invoices = await prisma.invoice.findMany({
      where: whereClause,
      include: {
        customer: true,
        items: {
          include: { product: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    const invoiceNos = invoices.map(i => i.invoiceNo);
    const bankTxs = invoiceNos.length > 0 ? await prisma.bankTransaction.findMany({
      where: {
        companyId,
        OR: invoiceNos.map(no => ({ remark: { contains: no } }))
      }
    }) : [];

    const enrichedInvoices = invoices.map(inv => {
      const relatedTxs = bankTxs.filter(t => t.remark && t.remark.includes(inv.invoiceNo));
      const paid = relatedTxs.length > 0 
        ? relatedTxs.reduce((sum, t) => sum + (t.amount || 0), 0)
        : (inv.status === 'PAID' && inv.paymentMode && inv.paymentMode.toLowerCase() !== 'credit' ? inv.totalAmount : 0);
      const balance = Math.max(0, (inv.totalAmount || 0) - paid);
      
      return {
        ...inv,
        paidAmount: paid,
        balance: balance
      };
    });

    res.status(200).json({ data: enrichedInvoices });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch transactions" });
  }
};

// Get a single transaction by ID
exports.getTransactionById = async (req, res) => {
  const { id } = req.params;
  const companyId = req.user.companyId;

  try {
    const invoice = await prisma.invoice.findFirst({
      where: {
        id: parseInt(id, 10),
        companyId,
        deletedAt: null
      },
      include: {
        customer: true,
        items: {
          include: { product: true }
        }
      }
    });

    if (!invoice) {
      return res.status(404).json({ error: "Invoice not found" });
    }

    res.status(200).json({ success: true, data: invoice });
  } catch (error) {
    console.error("Error fetching invoice by id:", error);
    res.status(500).json({ success: false, error: "Failed to fetch invoice details" });
  }
};

// Delete a transaction (Invoice)
exports.deleteTransaction = async (req, res) => {
  const { id } = req.params;
  const companyId = req.user.companyId;

  try {
    // Soft delete the invoice so it goes to the recycle bin
    await prisma.invoice.updateMany({
      where: {
        id: parseInt(id, 10),
        companyId // ensure they only delete their own invoice
      },
      data: {
        deletedAt: new Date()
      }
    });

    res.status(200).json({ success: true, message: "Invoice deleted successfully" });
  } catch (error) {
    console.error("Error deleting invoice:", error);
    res.status(500).json({ success: false, error: "Failed to delete invoice" });
  }
};

// Update a single transaction's status
exports.updateTransactionStatus = async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const companyId = req.user.companyId;

  if (!status) {
    return res.status(400).json({ error: "Status is required" });
  }

  try {
    const updatedInvoice = await prisma.invoice.updateMany({
      where: {
        id: parseInt(id, 10),
        companyId
      },
      data: { status }
    });

    res.status(200).json({ success: true, data: updatedInvoice });
  } catch (error) {
    console.error("Error updating transaction status:", error);
    res.status(500).json({ success: false, error: "Failed to update transaction status" });
  }
};

// Fetch all batches for a specific product
exports.getBatchesByProductId = async (req, res) => {
  const { productId } = req.params;
  const companyId = req.user.companyId;
  
  try {
    const pId = parseInt(productId, 10);
    // Find all invoice items for this product that have a batchNo
    const items = await prisma.invoiceItem.findMany({
      where: {
        productId: pId,
        invoice: {
          companyId: companyId
        },
        batchNo: {
          not: null,
          not: ""
        }
      },
      select: {
        batchNo: true,
        mfgDate: true,
        expDate: true
      },
      orderBy: {
        id: 'desc'
      }
    });

    // Extract unique batches with their most recent dates
    const uniqueBatches = [];
    const seenBatches = new Set();
    
    for (const item of items) {
      if (!seenBatches.has(item.batchNo)) {
        seenBatches.add(item.batchNo);
        uniqueBatches.push(item);
      }
    }

    res.status(200).json({ success: true, data: uniqueBatches });
  } catch (error) {
    console.error("Error fetching batches:", error);
    res.status(500).json({ success: false, error: "Failed to fetch batches" });
  }
};
