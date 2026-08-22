const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

exports.getLedger = async (req, res) => {
  const companyId = req.user.companyId;
  const { customerId } = req.params;
  const { fromDate, toDate } = req.query;

  let dateFilter = {};
  if (fromDate || toDate) {
    dateFilter.date = {};
    if (fromDate) {
      const start = new Date(fromDate);
      start.setHours(0, 0, 0, 0);
      dateFilter.date.gte = start;
    }
    if (toDate) {
      const end = new Date(toDate);
      end.setHours(23, 59, 59, 999);
      dateFilter.date.lte = end;
    }
  }

  try {
    // 1. Get customer
    const customer = await prisma.customer.findUnique({
      where: { id: parseInt(customerId, 10), companyId }
    });

    if (!customer) {
      return res.status(404).json({ success: false, message: 'Customer not found' });
    }

    const isSupplier = customer.type === 'COMPANY' || customer.type === 'SUPPLIER';
    const mainInvoiceType = isSupplier ? 'PURCHASE' : 'SALES';
    const returnInvoiceType = isSupplier ? 'PURCHASE_RETURN' : 'SALES_RETURN';

    // 2. Get all primary invoices (SALES for customer, PURCHASE for supplier)
    const invoices = await prisma.invoice.findMany({
      where: {
        customerId: parseInt(customerId, 10),
        companyId,
        type: mainInvoiceType,
        deletedAt: null,
        ...dateFilter
      },
      orderBy: { date: 'asc' }
    });

    // 3. Get all return invoices
    const returnInvoices = await prisma.invoice.findMany({
      where: {
        customerId: parseInt(customerId, 10),
        companyId,
        type: returnInvoiceType,
        deletedAt: null,
        ...dateFilter
      },
      orderBy: { date: 'asc' }
    });

    // 4. Get all customer payments from CustomerPayment table
    const payments = await prisma.customerPayment.findMany({
      where: {
        customerId: parseInt(customerId, 10),
        companyId,
        ...dateFilter
      },
      orderBy: { date: 'asc' }
    });

    // Helper to parse paymentMode strings (handles 'Credit', 'Credit:500', 'Cash:200,Credit:300', 'Cash', etc.)
    const parsePaymentDetails = (modeStr, totalAmount) => {
      const str = String(modeStr || 'Cash').trim();
      let upfrontPaid = 0;
      let isCredit = false;

      if (str.includes(':')) {
        const parts = str.split(',');
        for (const p of parts) {
          const [m, amt] = p.split(':');
          if (m && m.trim().toLowerCase() === 'credit') {
            isCredit = true;
          } else {
            upfrontPaid += parseFloat(amt) || 0;
          }
        }
      } else if (str.toLowerCase() === 'credit') {
        isCredit = true;
        upfrontPaid = 0;
      } else {
        upfrontPaid = totalAmount || 0;
      }

      return {
        isCredit,
        upfrontPaid,
        normalizedMode: isCredit ? 'Credit' : (str.includes(',') ? 'Split' : str)
      };
    };

    // 5. Build ledger entries array
    let entries = [];

    // Add invoices (DEBIT for customer, CREDIT for supplier)
    invoices.forEach(inv => {
      const { isCredit, upfrontPaid, normalizedMode } = parsePaymentDetails(inv.paymentMode, inv.totalAmount);
      entries.push({
        id: `INV-${inv.id}`,
        rawId: inv.id,
        type: 'INVOICE',
        date: inv.date,
        voucherNo: inv.invoiceNo,
        amount: inv.totalAmount,    // Total invoice amount
        paymentIn: upfrontPaid,     // Upfront paid cash/bank (0 for pure credit)
        discount: inv.totalDiscount || 0,
        paymentMode: normalizedMode,
        rawPaymentMode: inv.paymentMode,
        remark: inv.remark || null
      });
    });

    // Add returns
    returnInvoices.forEach(ret => {
      entries.push({
        id: `RET-${ret.id}`,
        rawId: ret.id,
        type: isSupplier ? 'PURCHASE_RETURN' : 'SALES_RETURN',
        date: ret.date,
        voucherNo: ret.invoiceNo,
        amount: 0,
        paymentIn: ret.totalAmount,  // Treated as credit reduction
        discount: 0,
        paymentMode: ret.paymentMode || 'Cash',
        remark: ret.remark || (isSupplier ? 'Purchase Return' : 'Sales Return')
      });
    });

    // Add payments from CustomerPayment table
    payments.forEach(pay => {
      const isCreditReduction = isSupplier ? pay.paymentType === 'OUT' : pay.paymentType === 'IN';
      entries.push({
        id: `PAY-${pay.id}`,
        rawId: pay.id,
        type: pay.paymentType === 'IN' ? 'PAYMENT_IN' : 'PAYMENT_OUT',
        date: pay.date,
        voucherNo: String(pay.id),
        amount: isCreditReduction ? 0 : pay.amount,
        paymentIn: isCreditReduction ? pay.amount : 0,
        discount: pay.discount || 0,
        paymentMode: pay.paymentMode || 'Cash',
        remark: pay.remark || null
      });
    });

    // 6. Sort all entries by date ascending
    entries.sort((a, b) => new Date(a.date) - new Date(b.date));

    // 7. Calculate running balance
    let runningBalance = 0;
    entries = entries.map(entry => {
      runningBalance += entry.amount;       // Debit
      runningBalance -= entry.paymentIn;   // Credit
      runningBalance -= entry.discount;    // Discount reduces balance
      return {
        ...entry,
        balance: runningBalance
      };
    });

    res.status(200).json({
      success: true,
      customer: {
        id: customer.id,
        name: customer.name,
        balance: customer.balance,
        details: `${customer.city || ''} ${customer.mobile ? `Mobile: ${customer.mobile}` : ''}`
      },
      data: entries
    });
  } catch (error) {
    console.error('Error fetching ledger:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};


exports.addPayment = async (req, res) => {
  const companyId = req.user.companyId;
  const { customerId } = req.params;
  const { date, amount, paymentType, paymentMode, referenceNo, discount, remark } = req.body;

  try {
    const parsedAmount = parseFloat(amount) || 0;
    const parsedDiscount = parseFloat(discount) || 0;

    // Payment IN = customer paid us -> balance decreases
    // Payment OUT = we paid customer -> balance increases
    let balanceAdjustment = 0;
    if (paymentType === 'IN') {
      balanceAdjustment = -(parsedAmount + parsedDiscount);
    } else {
      balanceAdjustment = (parsedAmount + parsedDiscount);
    }

    const result = await prisma.$transaction(async (tx) => {
      // Save payment record in CustomerPayment table
      const payment = await tx.customerPayment.create({
        data: {
          date: date ? new Date(date) : new Date(),
          amount: parsedAmount,
          discount: parsedDiscount,
          paymentType: paymentType || 'IN',
          paymentMode: paymentMode || 'Cash',
          remark: remark || null,
          customerId: parseInt(customerId, 10),
          companyId
        }
      });

      // Update customer balance
      const updatedCustomer = await tx.customer.update({
        where: { id: parseInt(customerId, 10) },
        data: {
          balance: { increment: balanceAdjustment }
        }
      });

      // Integrate with CashBook (Rojmel) if payment mode is Cash
      if ((paymentMode || 'Cash') === 'Cash') {
         const isSupplier = updatedCustomer.type === 'SUPPLIER';
         let particularText = '';
         if (isSupplier) {
           particularText = (paymentType === 'IN') ? 'Supplier Refund Received' : 'Supplier Payment Made';
         } else {
           particularText = (paymentType === 'IN') ? 'Customer Payment Received' : 'Customer Refund Paid';
         }

         await tx.cashBook.create({
           data: {
             date: date ? new Date(date) : new Date(),
             voucherNo: `PAY-${payment.id}`,
             type: paymentType === 'IN' ? 'Income' : 'Expense',
             particular: particularText,
             accountName: updatedCustomer.name,
             paymentType: 'Cash',
             cashIn: paymentType === 'IN' ? parsedAmount : 0,
             cashOut: paymentType === 'OUT' ? parsedAmount : 0,
             companyId
           }
         });
      }

      return { payment, newBalance: updatedCustomer.balance };
    });

    res.status(201).json({
      success: true,
      data: {
        customerId: parseInt(customerId, 10),
        amount: parsedAmount,
        discount: parsedDiscount,
        paymentType,
        remark,
        newBalance: result.newBalance
      }
    });
  } catch (error) {
    console.error('Error adding payment:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.deletePayment = async (req, res) => {
  const companyId = req.user.companyId;
  const { paymentId } = req.params;

  try {
    const payment = await prisma.customerPayment.findFirst({
      where: { id: parseInt(paymentId, 10), companyId }
    });

    if (!payment) {
      return res.status(404).json({ success: false, message: 'Payment record not found' });
    }

    await prisma.$transaction(async (tx) => {
      // Delete the payment record
      await tx.customerPayment.delete({
        where: { id: payment.id }
      });

      // Also delete the CashBook entry if it exists
      if ((payment.paymentMode || 'Cash') === 'Cash') {
         await tx.cashBook.deleteMany({
           where: { voucherNo: `PAY-${payment.id}`, companyId }
         });
      }

      // Update customer balance (Payment IN was negative, so we subtract the adjustment, meaning we add it back)
      // Payment OUT was positive, so we subtract the adjustment
      const balanceAdjustment = payment.paymentType === 'IN' 
        ? (payment.amount + payment.discount) 
        : -(payment.amount + payment.discount);

      await tx.customer.update({
        where: { id: payment.customerId },
        data: {
          balance: { increment: balanceAdjustment }
        }
      });
    });

    res.status(200).json({ success: true, message: 'Payment record deleted successfully' });
  } catch (error) {
    console.error('Error deleting payment:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

